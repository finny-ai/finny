import { InstallationVersion } from "@opencode-ai/core/installation/version"

const version = InstallationVersion.startsWith("v") ? InstallationVersion : `v${InstallationVersion}`

export const finnyLogo = {
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

export const logo = {
  left: ["                 ", "█▀▀▀ ▀█▀ █▄  █", "█▀▀   █  █ █ █", "█     █  █  ▀█"],
  right: ["             ", "█▄  █ █   █", "█ █ █  █ █ ", "█  ▀█   █  "],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
