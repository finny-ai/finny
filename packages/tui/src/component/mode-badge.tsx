import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import type { BrokerMode } from "@/live/brokers"

/** Human-readable label for a broker mode. Defaults to PAPER when unknown. */
export function modeLabel(mode: BrokerMode | undefined): string {
  if (mode === "live") return "LIVE"
  if (mode === "testnet") return "TESTNET"
  return "PAPER"
}

/** True when the mode trades real money. */
export function isLiveMode(mode: BrokerMode | undefined): boolean {
  return mode === "live"
}

/**
 * Small inline chip that makes paper/testnet vs live unmistakable. LIVE is
 * rendered with the error color (real money); paper/testnet use the calmer
 * info color (virtual money).
 */
export function ModeBadge(props: { mode: BrokerMode | undefined }) {
  const { theme } = useTheme()
  const live = () => isLiveMode(props.mode)
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={live() ? theme.error : theme.info}
      flexShrink={0}
    >
      <text fg={theme.background} attributes={TextAttributes.BOLD}>
        {modeLabel(props.mode)}
      </text>
    </box>
  )
}
