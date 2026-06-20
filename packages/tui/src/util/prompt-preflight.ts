const PREFLIGHT_AGENTS = new Set(["build", "research"])

/** Build and Research always bootstrap a workspace + python env before the LLM runs. */
export function promptNeedsWorkspacePreflight(_prompt: string, agent: string): boolean {
  return PREFLIGHT_AGENTS.has(agent)
}
