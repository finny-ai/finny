import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "../context/theme"
import { Card } from "./card"

const STEPS = [
  { num: "1", title: "Describe a strategy", hint: "Type what you want to build in the prompt." },
  { num: "2", title: "Choose your mode", hint: "Build / Research / Chat — press Tab to cycle." },
  { num: "3", title: "Backtest & iterate", hint: "Run /backtest, review metrics, refine." },
]

export function GettingStartedCard(props: { onDismiss?: () => void }) {
  const { theme } = useTheme()
  return (
    <Card title=" Getting started ">
      <box flexDirection="column" gap={1}>
        <For each={STEPS}>
          {(step) => (
            <box flexDirection="row" gap={2}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                {step.num}
              </text>
              <box flexDirection="column" flexGrow={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {step.title}
                </text>
                <text fg={theme.textMuted}>{step.hint}</text>
              </box>
            </box>
          )}
        </For>
        {props.onDismiss ? (
          <box paddingTop={1} flexDirection="row">
            <text fg={theme.textMuted} onMouseUp={props.onDismiss}>
              dismiss
            </text>
          </box>
        ) : null}
      </box>
    </Card>
  )
}
