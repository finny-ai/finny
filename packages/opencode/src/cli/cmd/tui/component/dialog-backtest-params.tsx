import { TextAttributes } from "@opentui/core"
import { createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useKeyboard } from "@opentui/solid"

// Standard preset chips. Chat-derived non-preset durations are injected at the
// front of the list when present.
const STANDARD_DURATIONS = [
  { label: "1 week", value: "1w" },
  { label: "2 weeks", value: "2w" },
  { label: "1 month", value: "1m" },
  { label: "3 months", value: "3m" },
  { label: "6 months", value: "6m" },
  { label: "1 year", value: "1y" },
] as const

const INTERVALS = [
  { label: "1min", value: "1min" },
  { label: "5min", value: "5min" },
  { label: "15min", value: "15min" },
  { label: "30min", value: "30min" },
  { label: "1h", value: "1h" },
  { label: "4h", value: "4h" },
  { label: "1d", value: "1d" },
] as const

const CAPITALS = [
  { label: "$1,000", value: "1000" },
  { label: "$5,000", value: "5000" },
  { label: "$10,000", value: "10000" },
  { label: "$50,000", value: "50000" },
  { label: "$100,000", value: "100000" },
] as const

type Field = "duration" | "interval" | "capital"
const FIELDS: Field[] = ["duration", "interval", "capital"]

export interface BacktestParamsResult {
  duration: string
  interval: string
  capital: string
}

export interface BacktestParamsDefaults {
  duration?: string  // e.g., "2w" or any "Nd/Nw/Nm/Ny" — injected as first chip if non-standard
  interval?: string
  capital?: string   // dollar amount as string, e.g., "100"
}

export interface DialogBacktestParamsProps {
  algorithmName: string
  defaults?: BacktestParamsDefaults
  onConfirm: (params: BacktestParamsResult) => void
  onCancel?: () => void
}

function buildDurations(chatDuration?: string): { label: string; value: string }[] {
  const presets = STANDARD_DURATIONS.map((d) => ({ ...d }))
  if (!chatDuration) return presets
  if (presets.some((p) => p.value === chatDuration)) return presets
  // Non-standard chat duration → inject as the first chip.
  return [{ label: `Chat (${chatDuration})`, value: chatDuration }, ...presets]
}

function indexOfDuration(list: { value: string }[], value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const i = list.findIndex((d) => d.value === value)
  return i >= 0 ? i : fallback
}

function nearestCapitalIndex(target: string | undefined): number {
  if (!target) return 2
  const num = parseFloat(target)
  if (!Number.isFinite(num)) return 2
  let best = 0
  let bestDelta = Infinity
  for (let i = 0; i < CAPITALS.length; i++) {
    const v = parseFloat(CAPITALS[i].value)
    const d = Math.abs(v - num)
    if (d < bestDelta) {
      best = i
      bestDelta = d
    }
  }
  return best
}

export function DialogBacktestParams(props: DialogBacktestParamsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const allDurations = createMemo(() => buildDurations(props.defaults?.duration))
  const allowedDurations = allDurations

  const initialDurationIdx = () => indexOfDuration(allowedDurations(), props.defaults?.duration, 0)
  const initialIntervalIdx = () => indexOfDuration(INTERVALS as any, props.defaults?.interval, 4)
  const initialCapitalIdx = () => nearestCapitalIndex(props.defaults?.capital)

  const [store, setStore] = createStore({
    active: "duration" as Field,
    durationIndex: 0,
    intervalIndex: 4,
    capitalIndex: 2,
  })

  function cycleOption(field: Field, direction: number) {
    if (field === "duration") {
      const len = allowedDurations().length
      if (len === 0) return
      const next = (store.durationIndex + direction + len) % len
      setStore("durationIndex", next)
    } else if (field === "interval") {
      setStore("intervalIndex", (store.intervalIndex + direction + INTERVALS.length) % INTERVALS.length)
    } else if (field === "capital") {
      setStore("capitalIndex", (store.capitalIndex + direction + CAPITALS.length) % CAPITALS.length)
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.shift && evt.name === "tab")) {
      const idx = FIELDS.indexOf(store.active)
      setStore("active", FIELDS[(idx - 1 + FIELDS.length) % FIELDS.length])
      evt.preventDefault()
    }
    if (evt.name === "down" || evt.name === "tab") {
      const idx = FIELDS.indexOf(store.active)
      setStore("active", FIELDS[(idx + 1) % FIELDS.length])
      evt.preventDefault()
    }
    if (evt.name === "left") {
      cycleOption(store.active, -1)
      evt.preventDefault()
    }
    if (evt.name === "right") {
      cycleOption(store.active, 1)
      evt.preventDefault()
    }
    if (evt.name === "return") {
      props.onConfirm({
        duration: allowedDurations()[store.durationIndex]?.value ?? "1m",
        interval: INTERVALS[store.intervalIndex].value,
        capital: CAPITALS[store.capitalIndex].value,
      })
      evt.preventDefault()
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setStore("durationIndex", initialDurationIdx())
    setStore("intervalIndex", initialIntervalIdx())
    setStore("capitalIndex", initialCapitalIdx())
  })

  function FieldRow(fieldProps: {
    label: string
    field: Field
    options: ReadonlyArray<{ label: string; value: string }>
    selectedIndex: number
  }) {
    const active = () => store.active === fieldProps.field
    return (
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={active() ? theme.backgroundElement : undefined}
        onMouseUp={() => setStore("active", fieldProps.field)}
      >
        <text fg={active() ? theme.primary : theme.text} attributes={active() ? TextAttributes.BOLD : undefined}>
          {fieldProps.label}
        </text>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>{active() ? "◀" : " "}</text>
          <text
            fg={active() ? theme.primary : theme.text}
            attributes={active() ? TextAttributes.BOLD : undefined}
          >
            {fieldProps.options[fieldProps.selectedIndex]?.label ?? "—"}
          </text>
          <text fg={theme.textMuted}>{active() ? "▶" : " "}</text>
        </box>
      </box>
    )
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Backtest — {props.algorithmName}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <box>
        <FieldRow label="Duration" field="duration" options={allowedDurations()} selectedIndex={store.durationIndex} />
        <FieldRow label="Interval" field="interval" options={INTERVALS} selectedIndex={store.intervalIndex} />
        <FieldRow label="Capital" field="capital" options={CAPITALS} selectedIndex={store.capitalIndex} />
      </box>

      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>←/→</span> change value · <span style={{ fg: theme.text }}>↑/↓</span> switch
        field · <span style={{ fg: theme.text }}>enter</span> confirm
      </text>
    </box>
  )
}

DialogBacktestParams.show = (
  dialog: DialogContext,
  algorithmName: string,
  defaults?: BacktestParamsDefaults,
) => {
  return new Promise<BacktestParamsResult | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogBacktestParams
          algorithmName={algorithmName}
          defaults={defaults}
          onConfirm={(params) => resolve(params)}
          onCancel={() => resolve(null)}
        />
      ),
      () => resolve(null),
    )
  })
}
