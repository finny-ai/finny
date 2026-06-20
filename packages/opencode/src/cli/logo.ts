import { InstallationVersion } from "@opencode-ai/core/installation/version"
export { go } from "@opencode-ai/tui/logo"

const version = InstallationVersion.startsWith("v") ? InstallationVersion : `v${InstallationVersion}`

export const logo = {
  lines: [
    "███████╗██╗███╗   ██╗███╗   ██╗██╗   ██╗",
    "██╔════╝██║████╗  ██║████╗  ██║╚██╗ ██╔╝",
    "█████╗  ██║██╔██╗ ██║██╔██╗ ██║ ╚████╔╝ ",
    "██╔══╝  ██║██║╚██╗██║██║╚██╗██║  ╚██╔╝  ",
    "██║     ██║██║ ╚████║██║ ╚████║   ██║   ",
    "╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝  ╚═══╝   ╚═╝   ",
  ],
  tagline: "Think Strategies, Ship Alpha",
  version: `${version} • AI Financial Harness`,
}
