import { createSignal, For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { SegmentedControl, type SegmentedOption } from "../ui/segmented-control"

type Currency = "CAD" | "USD" | "EUR"
type AccountType = "TFSA" | "RRSP" | "Non-reg" | "Other"
type Horizon = "1y" | "3y" | "5y" | "10y+"
type Risk = "Conservative" | "Balanced" | "Growth" | "Aggressive"
type Geography = "Global" | "N.America" | "Canada"
type AssetClass = "Stocks" | "ETFs" | "Crypto" | "Bonds"

const FUNDS_OPTS: SegmentedOption<string>[] = [
  { value: "1000", label: "1k" },
  { value: "5000", label: "5k" },
  { value: "10000", label: "10k" },
  { value: "25000", label: "25k" },
  { value: "50000", label: "50k" },
  { value: "100000", label: "100k" },
  { value: "250000", label: "250k" },
]

const CURRENCY_OPTS: SegmentedOption<Currency>[] = [
  { value: "CAD", label: "CAD" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
]

const ACCOUNT_OPTS: SegmentedOption<AccountType>[] = [
  { value: "TFSA", label: "TFSA" },
  { value: "RRSP", label: "RRSP" },
  { value: "Non-reg", label: "Non-reg" },
  { value: "Other", label: "Other" },
]

const HORIZON_OPTS: SegmentedOption<Horizon>[] = [
  { value: "1y", label: "1y" },
  { value: "3y", label: "3y" },
  { value: "5y", label: "5y" },
  { value: "10y+", label: "10y+" },
]

const RISK_OPTS: SegmentedOption<Risk>[] = [
  { value: "Conservative", label: "Conserv" },
  { value: "Balanced", label: "Balanced" },
  { value: "Growth", label: "Growth" },
  { value: "Aggressive", label: "Aggro" },
]

const GEO_OPTS: SegmentedOption<Geography>[] = [
  { value: "Global", label: "Global" },
  { value: "N.America", label: "N.America" },
  { value: "Canada", label: "Canada" },
]

const ASSET_OPTS: AssetClass[] = ["Stocks", "ETFs", "Crypto", "Bonds"]

function FieldRow(props: { label: string; children: any }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
      <box width={12} flexShrink={0}>
        <text fg={theme.textMuted}>{props.label}</text>
      </box>
      <box flexShrink={0}>{props.children}</box>
    </box>
  )
}

export function PortfolioBuilder() {
  const { theme } = useTheme()
  const route = useRoute()
  const toast = useToast()
  const local = useLocal()

  const [funds, setFunds] = createSignal<string>("25000")
  const [currency, setCurrency] = createSignal<Currency>("CAD")
  const [account, setAccount] = createSignal<AccountType>("TFSA")
  const [horizon, setHorizon] = createSignal<Horizon>("5y")
  const [risk, setRisk] = createSignal<Risk>("Balanced")
  const [geography, setGeography] = createSignal<Geography>("Global")
  const [assets, setAssets] = createSignal<Set<AssetClass>>(
    new Set(["Stocks", "ETFs", "Crypto", "Bonds"]),
  )

  const toggleAsset = (a: AssetClass) => {
    const next = new Set(assets())
    if (next.has(a)) next.delete(a)
    else next.add(a)
    setAssets(next)
  }

  const formatPrompt = (): string => {
    const universe = Array.from(assets()).join(", ") || "(none)"
    return [
      "Build me a diversified investment portfolio with these inputs:",
      "",
      `- Funds: ${currency()} ${funds()}`,
      `- Account type: ${account()}`,
      `- Time horizon: ${horizon()}`,
      `- Risk tolerance: ${risk()}`,
      `- Asset universe: ${universe}`,
      `- Geographic preference: ${geography()}`,
      "",
      "Produce the full plan in the structured markdown format. Then offer to backtest it.",
    ].join("\n")
  }

  const onBuild = () => {
    if (assets().size === 0) {
      toast.show({ message: "Pick at least one asset class.", variant: "warning", duration: 3000 })
      return
    }
    local.agent.set("portfolio_builder")
    route.navigate({
      type: "home",
      initialPrompt: { input: formatPrompt(), parts: [] },
      autoSubmit: true,
    })
    toast.show({
      message: "Building your portfolio…",
      variant: "info",
      duration: 2500,
    })
  }

  return (
    <box flexGrow={1} flexDirection="column" minHeight={0}>
      <RouteHeader
        icon={ROUTE_ICONS["portfolio-builder"] as unknown as string[]}
        title="Portfolio Builder"
        subtitle="Recommendation only. Not financial advice."
      />

      <box
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={2}
        paddingBottom={2}
        flexDirection="column"
        gap={0}
        minHeight={0}
      >
        <FieldRow label="Funds">
          <SegmentedControl options={FUNDS_OPTS} value={funds()} onChange={setFunds} />
        </FieldRow>

        <FieldRow label="Currency">
          <SegmentedControl options={CURRENCY_OPTS} value={currency()} onChange={setCurrency} />
        </FieldRow>

        <FieldRow label="Account">
          <SegmentedControl options={ACCOUNT_OPTS} value={account()} onChange={setAccount} />
        </FieldRow>

        <FieldRow label="Horizon">
          <SegmentedControl options={HORIZON_OPTS} value={horizon()} onChange={setHorizon} />
        </FieldRow>

        <FieldRow label="Risk">
          <SegmentedControl options={RISK_OPTS} value={risk()} onChange={setRisk} />
        </FieldRow>

        <FieldRow label="Universe">
          <box flexDirection="row" gap={3} flexShrink={0}>
            <For each={ASSET_OPTS}>
              {(a) => {
                const on = () => assets().has(a)
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    paddingBottom={1}
                    border={["bottom"]}
                    borderColor={on() ? theme.primary : theme.background}
                    onMouseUp={() => toggleAsset(a)}
                  >
                    <text
                      fg={on() ? theme.text : theme.textMuted}
                      attributes={on() ? TextAttributes.BOLD : 0}
                    >
                      {on() ? "[x] " : "[ ] "}
                      {a}
                    </text>
                  </box>
                )
              }}
            </For>
          </box>
        </FieldRow>

        <FieldRow label="Geography">
          <SegmentedControl options={GEO_OPTS} value={geography()} onChange={setGeography} />
        </FieldRow>

        <box flexDirection="row" gap={2} flexShrink={0} paddingTop={2}>
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={theme.primary}
            onMouseUp={onBuild}
          >
            <text fg={theme.background} attributes={TextAttributes.BOLD}>
              ◆ Build my portfolio
            </text>
          </box>
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={theme.backgroundElement}
            onMouseUp={() => route.navigate({ type: "home" })}
          >
            <text fg={theme.text}>Cancel</text>
          </box>
        </box>

        <box flexShrink={0} paddingTop={2}>
          <text fg={theme.textMuted}>
            TFSA mode flags Canadian-eligible securities and US withholding tax.
          </text>
        </box>
      </box>
    </box>
  )
}
