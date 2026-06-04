import { VERSION } from "@/installation/meta"

const version = VERSION.startsWith("v") ? VERSION : `v${VERSION}`

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

export const marks = "_^~"
