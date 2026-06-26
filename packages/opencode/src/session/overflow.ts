import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000
const DEFAULT_COMPACTION_RATIO = 0.6

/**
 * Resolve the early-compaction ratio for a model. Per-model overrides
 * (keyed "<providerID>/<modelID>") win over the global `ratio`, which in
 * turn defaults to {@link DEFAULT_COMPACTION_RATIO}. A ratio that is not a
 * finite number in (0, 1) means "no early cap" (compact only near the hard
 * limit) — this is how users disable the behavior with `ratio: 1`.
 */
function compactionRatio(cfg: ConfigV1.Info, model: Provider.Model): number | undefined {
  const key = `${model.providerID}/${model.id}`
  const ratio = cfg.compaction?.ratio_overrides?.[key] ?? cfg.compaction?.ratio ?? DEFAULT_COMPACTION_RATIO
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return undefined
  return ratio
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  const hard = input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))

  // Compact early, before long context degrades model quality. The ratio is a
  // cap on top of the hard usable limit, so it can only ever lower the
  // threshold — never raise it past what the model can actually hold.
  const ratio = compactionRatio(input.cfg, input.model)
  if (ratio === undefined) return hard
  return Math.min(hard, Math.floor(context * ratio))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
