const ENABLED_VALUES = new Set(["1", "true", "ture", "yes", "on"])

export function finnyCloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FINNY_CLOUD?.trim().toLowerCase()
  return value !== undefined && ENABLED_VALUES.has(value)
}

export function finnyEnterpriseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FINNY_ENTERPRISE?.trim().toLowerCase()
  return value !== undefined && ENABLED_VALUES.has(value)
}

export type FinnyProductMode = "cloud" | "enterprise" | "default"

export function finnyProductMode(env: NodeJS.ProcessEnv = process.env): FinnyProductMode {
  if (finnyEnterpriseEnabled(env)) return "enterprise"
  if (finnyCloudEnabled(env)) return "cloud"
  return "default"
}

export function finnyProductName(env: NodeJS.ProcessEnv = process.env): string {
  const mode = finnyProductMode(env)
  if (mode === "cloud") return "Finny Cloud"
  if (mode === "enterprise") return "Finny Enterprise"
  return "Finny"
}
