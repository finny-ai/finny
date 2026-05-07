import { tool } from "@opencode-ai/plugin"
import { fetchChannelPosts, discordChannels } from "@finny-ai/integrations/discord"

export const discord = tool({
  description:
    "Read the latest news posts from a Finny Discord news channel. " +
    "Each channel mirrors a curated RSS feed via MonitoRSS. Returns headline, excerpt, " +
    "and source URL for each post. Use this to ground answers in current news " +
    "(e.g., political headlines, options flow, dark pool activity, market news, congressional trades). " +
    `Available channels: ${discordChannels().join(", ")}.`,
  args: {
    channel: tool.schema
      .string()
      .describe("Channel name, e.g. 'trump', 'options-flow', 'dark-pool', 'china-us-news', 'market-news', 'congressional-trades'"),
    limit: tool.schema
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("How many recent posts to return (1-20, default 5)"),
  },
  async execute(args) {
    const posts = await fetchChannelPosts(args.channel, args.limit ?? 5)
    return JSON.stringify(posts, null, 2)
  },
})
