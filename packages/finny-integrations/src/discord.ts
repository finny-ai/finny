const API = "https://discord.com/api/v10"

const CHANNELS: Record<string, string> = {
  "trump": process.env.DISCORD_CHANNEL_TRUMP ?? "",
  "options-flow": process.env.DISCORD_CHANNEL_OPTIONS_FLOW ?? "",
  "dark-pool": process.env.DISCORD_CHANNEL_DARK_POOL ?? "",
  "china-us-news": process.env.DISCORD_CHANNEL_CHINA_US_NEWS ?? "",
  "market-news": process.env.DISCORD_CHANNEL_MARKET_NEWS ?? "",
  "congressional-trades": process.env.DISCORD_CHANNEL_CONGRESSIONAL_TRADES ?? "",
}

export type DiscordPost = {
  id: string
  timestamp: string
  title: string
  excerpt: string
  url: string
}

type Component = {
  type: number
  content?: string
  url?: string
  style?: number
  label?: string
  components?: Component[]
}

type DiscordMessage = {
  id: string
  timestamp: string
  content: string
  embeds: Array<{ title?: string; description?: string; url?: string }>
  components?: Component[]
}

export const discordChannels = () => Object.keys(CHANNELS)

export async function fetchChannelPosts(channel: string, limit: number): Promise<DiscordPost[]> {
  const id = CHANNELS[channel]
  if (!id) {
    throw new Error(
      `Unknown channel '${channel}'. Known: ${Object.keys(CHANNELS).join(", ")}. ` +
        `If the channel is in the list but unconfigured, set the corresponding DISCORD_CHANNEL_* env var.`,
    )
  }
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token) throw new Error("DISCORD_BOT_TOKEN not set")

  const clamped = Math.min(Math.max(limit, 1), 20)
  const res = await fetch(`${API}/channels/${id}/messages?limit=${clamped}`, {
    headers: { Authorization: `Bot ${token}` },
  })
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`)
  const messages = (await res.json()) as DiscordMessage[]

  return messages.map((m) => extractPost(m)).filter((p) => p.title || p.excerpt)
}

function extractPost(m: DiscordMessage): DiscordPost {
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

function walk(components: Component[], visit: (c: Component) => void) {
  for (const c of components) {
    visit(c)
    if (c.components?.length) walk(c.components, visit)
  }
}

// MonitoRSS Components-V2 text is typically `**HEADLINE**\nexcerpt...`.
// Pull the bolded first line as title, remainder as excerpt.
function splitTitleExcerpt(text: string): { title: string; excerpt: string } {
  if (!text) return { title: "", excerpt: "" }
  const newline = text.indexOf("\n")
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim()
  const rest = newline === -1 ? "" : text.slice(newline + 1).trim()
  const bolded = firstLine.match(/^\*\*(.+?)\*\*$/s)
  if (bolded) return { title: bolded[1].trim(), excerpt: rest }
  return { title: firstLine, excerpt: rest }
}
