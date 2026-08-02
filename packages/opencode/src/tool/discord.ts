import z from "zod"
import os from "os"
import path from "path"
import fs from "fs"
import { Effect } from "effect"
import { Tool } from "./tool"

const API = "https://discord.com/api/v10"

const CHANNEL_ENV: Record<string, string> = {
  "trump": "DISCORD_CHANNEL_TRUMP",
  "options-flow": "DISCORD_CHANNEL_OPTIONS_FLOW",
  "dark-pool": "DISCORD_CHANNEL_DARK_POOL",
  "china-us-news": "DISCORD_CHANNEL_CHINA_US_NEWS",
  "market-news": "DISCORD_CHANNEL_MARKET_NEWS",
  "congressional-trades": "DISCORD_CHANNEL_CONGRESSIONAL_TRADES",
  "fed-fomc": "DISCORD_CHANNEL_FED_FOMC",
  "fed-speakers": "DISCORD_CHANNEL_FED_SPEAKERS",
}

const CHANNEL_NAMES = Object.keys(CHANNEL_ENV)

// Discord snowflake IDs are 17-20 digit decimal strings. Defense in depth so
// a misconfigured env var can't smuggle path segments or query params into the
// outbound URL.
const SNOWFLAKE = /^\d{17,20}$/

const parameters = z.object({
  channel: z
    .enum(CHANNEL_NAMES as [string, ...string[]])
    .describe("Which Finny Discord news channel to read."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("How many recent posts to return (1-20, default 5)."),
})

type Component = {
  type: number
  content?: string
  url?: string
  style?: number
  components?: Component[]
}

type DiscordMessage = {
  id: string
  timestamp: string
  content: string
  embeds: Array<{ title?: string; description?: string; url?: string }>
  components?: Component[]
}

type Post = { id: string; timestamp: string; title: string; excerpt: string; url: string }

// Bun auto-loads .env from cwd, but the desktop/TUI launches the agent from
// an unpredictable cwd. Fall back to ~/.finny/discord.env so the user can
// place a single, stable secret file.
let envLoaded = false
function ensureEnv() {
  if (envLoaded) return
  envLoaded = true
  if (process.env.DISCORD_BOT_TOKEN) return
  const candidates = [
    path.join(os.homedir(), ".finny", "discord.env"),
    path.join(os.homedir(), ".config", "finny", "discord.env"),
  ]
  for (const file of candidates) {
    let txt: string
    try {
      txt = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const parsed = parseEnvFile(txt)
    for (const [k, v] of Object.entries(parsed)) {
      if (!process.env[k]) process.env[k] = v
    }
    if (process.env.DISCORD_BOT_TOKEN) return
  }
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, k, raw] = m
    const v = raw.replace(/^['"]|['"]$/g, "")
    out[k] = v
  }
  return out
}

function walk(components: Component[], visit: (c: Component) => void) {
  for (const c of components) {
    visit(c)
    if (c.components?.length) walk(c.components, visit)
  }
}

function splitTitleExcerpt(text: string): { title: string; excerpt: string } {
  if (!text) return { title: "", excerpt: "" }
  const newline = text.indexOf("\n")
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim()
  const rest = newline === -1 ? "" : text.slice(newline + 1).trim()
  const bolded = firstLine.match(/^\*\*(.+?)\*\*$/s)
  if (bolded) return { title: bolded[1].trim(), excerpt: rest }
  return { title: firstLine, excerpt: rest }
}

function extractPost(m: DiscordMessage): Post {
  const embed = m.embeds?.[0]
  if (embed && (embed.title || embed.description || embed.url)) {
    return {
      id: m.id,
      timestamp: m.timestamp,
      title: embed.title ?? "",
      excerpt: embed.description ?? "",
      url: embed.url ?? "",
    }
  }
  const texts: string[] = []
  let url = ""
  walk(m.components ?? [], (c) => {
    if (c.type === 10 && c.content) texts.push(c.content)
    if (c.type === 2 && c.style === 5 && c.url && !url) url = c.url
  })
  const text = texts.join("\n").trim() || (m.content ?? "")
  const { title, excerpt } = splitTitleExcerpt(text)
  return { id: m.id, timestamp: m.timestamp, title, excerpt, url }
}

async function fetchPosts(channel: string, limit: number, abort?: AbortSignal): Promise<Post[]> {
  ensureEnv()
  const envKey = CHANNEL_ENV[channel]
  const id = envKey ? process.env[envKey] : undefined
  if (!id) {
    throw new Error(
      `Channel '${channel}' not configured. Set ${envKey ?? "the DISCORD_CHANNEL_* var"} in ~/.finny/discord.env. ` +
        `Known channels: ${CHANNEL_NAMES.join(", ")}.`,
    )
  }
  if (!SNOWFLAKE.test(id)) {
    throw new Error(`${envKey} is not a valid Discord channel ID (expected 17-20 digits).`)
  }
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN not set. Put it in ~/.finny/discord.env (one line: DISCORD_BOT_TOKEN=...).",
    )
  }
  const clamped = Math.min(Math.max(limit, 1), 20)
  const res = await fetch(`${API}/channels/${id}/messages?limit=${clamped}`, {
    headers: { Authorization: `Bot ${token}` },
    signal: abort,
  })
  if (!res.ok) {
    // Never echo the token in error messages, even if Discord did (it doesn't,
    // but defense in depth).
    const body = (await res.text()).slice(0, 200)
    throw new Error(`Discord API ${res.status}: ${body.replace(token, "<redacted>")}`)
  }
  const messages = (await res.json()) as DiscordMessage[]
  return messages.map(extractPost).filter((p) => p.title || p.excerpt)
}

export const DiscordReadTool = Tool.define(
  "finny_discord_read",
  Effect.succeed({
    description:
      "Read the latest news posts from a Finny Discord news channel. Each channel mirrors a curated " +
      "RSS feed via MonitoRSS. Returns headline, excerpt, and source URL per post. Use this to ground " +
      "answers in current news (Trump statements, options flow, dark pool / SEC filings, China-US news, " +
      "market headlines, congressional/political news, FOMC statements, Fed speeches). " +
      "Available channels: " +
      CHANNEL_NAMES.join(", ") +
      ".",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        await Effect.runPromise(
          ctx.ask({
            permission: "finny_discord_read",
            patterns: ["*"],
            always: ["*"],
            metadata: { channel: params.channel, limit: params.limit ?? 5 },
          }),
        )

        try {
          const posts = await fetchPosts(params.channel, params.limit ?? 5, ctx.abort)
          if (!posts.length) {
            return {
              title: `#${params.channel} — no posts`,
              output: `No readable posts found in #${params.channel}.`,
              metadata: { channel: params.channel, count: 0 },
            }
          }
          const lines: string[] = [`#${params.channel} — ${posts.length} latest post(s):`, ""]
          for (const p of posts) {
            lines.push(`• [${p.timestamp.slice(0, 16).replace("T", " ")} UTC]`)
            if (p.title) lines.push(`  ${p.title}`)
            if (p.excerpt) lines.push(`  ${p.excerpt.slice(0, 400)}${p.excerpt.length > 400 ? "…" : ""}`)
            if (p.url) lines.push(`  Source: ${p.url}`)
            lines.push("")
          }
          return {
            title: `#${params.channel} (${posts.length})`,
            output: lines.join("\n").trim(),
            metadata: { channel: params.channel, count: posts.length, urls: posts.map((p) => p.url) },
          }
        } catch (e: any) {
          return {
            title: "Discord read failed",
            output: e?.message ?? "Unknown error",
            metadata: { error: "fetch_failed", channel: params.channel },
          }
        }
      }),
  }),
)
