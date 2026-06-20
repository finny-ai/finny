const ENABLED_VALUES = new Set(["1", "true", "yes", "on"])

export function finnyCloudEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FINNY_CLOUD?.trim().toLowerCase()
  return value !== undefined && ENABLED_VALUES.has(value)
}
