export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  // Trigger compaction when context usage reaches this fraction of the model
  // context window (0–1, default 0.6). >= 1 disables early compaction.
  ratio: Schema.Number.pipe(Schema.optional),
  // Per-model overrides for `ratio`, keyed by "<providerID>/<modelID>".
  ratio_overrides: Schema.Record(Schema.String, Schema.Number).pipe(Schema.optional),
}) {}
