// Finny fork: upstream update checks hit the opencode-ai npm package and
// would prompt users to "upgrade" to an unrelated opencode release. Disable
// until Finny has its own update channel wired up.
export async function upgrade() {
  return
}
