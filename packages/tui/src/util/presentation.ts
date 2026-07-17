import { finnyLogo } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

function wordmark(pad = "") {
  const brand = "\x1b[38;2;99;102;241m"
  return finnyLogo.lines.map((line) => `${pad}${brand}${line}${reset}`)
}

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    ...wordmark("  "),
    "",
    `  ${dim}${finnyLogo.tagline}${reset}`,
    `  ${dim}${finnyLogo.version}${reset}`,
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}finny -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
