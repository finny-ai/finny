import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { Card } from "./card"

export function PortfolioCard() {
  const { theme } = useTheme()
  const route = useRoute()
  return (
    <Card title=" Portfolio ">
      <box
        flexGrow={1}
        alignItems="center"
        justifyContent="center"
        gap={1}
        onMouseUp={() => route.navigate({ type: "portfolio" })}
      >
        <text fg={theme.textMuted}>No portfolio connected</text>
        <text fg={theme.textMuted}>
          Click to set up paper trading.
        </text>
      </box>
    </Card>
  )
}
