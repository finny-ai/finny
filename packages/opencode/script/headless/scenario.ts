import crypto from "node:crypto"
import fs from "node:fs/promises"
import { HeadlessScenarioV1, type HeadlessScenarioV1 as Scenario } from "./types"

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function canonicalScenarioJson(scenario: Scenario): string {
  return stable(HeadlessScenarioV1.parse(scenario))
}

export function scenarioSha256(scenario: Scenario): string {
  return crypto.createHash("sha256").update(canonicalScenarioJson(scenario)).digest("hex")
}

export async function loadScenario(file: string): Promise<HeadlessScenarioV1> {
  const raw = JSON.parse(await fs.readFile(file, "utf8"))
  return HeadlessScenarioV1.parse(raw)
}
