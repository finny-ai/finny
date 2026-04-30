import { createSignal, onMount, Show } from "solid-js"
import { TextAttributes, MouseEvent } from "@opentui/core"
import open from "open"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { Card } from "./card"
import { DialogManagedHosting } from "./dialog-managed-hosting"
import { Plan } from "@/plan"

const PRO_URL = "https://finnyai.tech/pro"
const LITE_URL = "https://finnyai.tech/lite"

export function SettingsPanelPro() {
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()

  const [tier, setTier] = createSignal<Plan.Tier>("free")
  const [proKey, setProKey] = createSignal<string | null>(null)
  const [liteKey, setLiteKey] = createSignal<string | null>(null)
  const [licenseInput, setLicenseInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    setTier(await Plan.getTier())
    setProKey(await Plan.getLicenseKey("pro"))
    setLiteKey(await Plan.getLicenseKey("lite"))
  }

  onMount(refresh)

  const activate = async () => {
    if (busy()) return
    const key = licenseInput().trim()
    if (!key) {
      toast.show({ message: "Please paste your license code", variant: "warning", duration: 3000 })
      return
    }
    setBusy(true)
    try {
      const detected = await Plan.setLicenseKey(key)
      if (!detected) {
        toast.show({
          message: "Unrecognized license code. Codes start with FINNY-LITE- or FINNY-PRO-.",
          variant: "error",
          duration: 5000,
        })
        return
      }
      const newTier = await Plan.getTier()
      // If activation didn't elevate the tier to at least the detected level, the signature failed.
      if (!Plan.hasAtLeast(newTier, detected)) {
        await Plan.removeLicenseKey(detected)
        toast.show({ message: "Invalid license code. Check your code and try again.", variant: "error", duration: 5000 })
      } else {
        const label = detected === "pro" ? "Finny Pro" : "Finny Lite"
        toast.show({ message: `${label} activated!`, variant: "info", duration: 4000 })
        setLicenseInput("")
        await refresh()
      }
    } catch (e: any) {
      toast.show({ message: `Error: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const removeLicense = async (which: Exclude<Plan.Tier, "free">) => {
    if (busy()) return
    setBusy(true)
    try {
      await Plan.removeLicenseKey(which)
      toast.show({ message: `${which === "pro" ? "Pro" : "Lite"} license removed`, variant: "info", duration: 3000 })
      await refresh()
    } catch (e: any) {
      toast.show({ message: `Error: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const InputBox = (props: { onInput: (v: string) => void }) => (
    <box
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
    >
      <input
        onInput={(v: string) => props.onInput(v)}
        onMouseDown={(r: MouseEvent) => r.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
      />
    </box>
  )

  const TierRow = (props: { label: string; active: boolean; popular?: boolean }) => (
    <box flexDirection="row" gap={1}>
      <text fg={props.active ? theme.success : theme.textMuted}>
        {props.active ? "✓" : "○"}
      </text>
      <text
        fg={props.active ? theme.text : theme.textMuted}
        attributes={props.active ? TextAttributes.BOLD : undefined}
      >
        {props.label}
      </text>
      <Show when={props.popular}>
        <text fg={theme.primary}>★ most popular</text>
      </Show>
    </box>
  )

  const openLite = () => {
    open(LITE_URL).catch(() => {
      toast.show({ message: LITE_URL, variant: "info", duration: 5000 })
    })
    toast.show({ message: "Opening Lite page in browser…", variant: "info", duration: 2000 })
  }
  const openPro = () => {
    open(PRO_URL).catch(() => {
      toast.show({ message: PRO_URL, variant: "info", duration: 5000 })
    })
    toast.show({ message: "Opening Pro page in browser…", variant: "info", duration: 2000 })
  }

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      {/* Left pane — plan ladder */}
      <box width={36} flexShrink={0} minHeight={0}>
        <Card title=" Plan ">
          <box flexDirection="column" gap={2}>
            <box flexDirection="column" gap={1}>
              <TierRow label="Free" active={tier() === "free"} />
              <TierRow label="Lite — $10/mo" active={tier() === "lite"} />
              <TierRow label="Pro" active={tier() === "pro"} popular />
            </box>

            <Show when={tier() === "free"}>
              <box paddingLeft={1} paddingRight={1} flexDirection="row" onMouseUp={openLite}>
                <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                  → Upgrade to Lite — $10/mo
                </text>
              </box>
            </Show>
            <Show when={tier() !== "pro"}>
              <box paddingLeft={1} paddingRight={1} flexDirection="row" onMouseUp={openPro}>
                <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                  → Buy Pro at finnyai.tech
                </text>
              </box>
            </Show>
          </box>
        </Card>
      </box>

      {/* Right pane */}
      <box flexGrow={1} minHeight={0}>
        <Show
          when={tier() !== "free"}
          fallback={
            <Card title=" Activate ">
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.textMuted}>
                    Paste a Lite or Pro license code from finnyai.tech.
                  </text>

                  <text fg={theme.textMuted}>License code</text>
                  <InputBox onInput={setLicenseInput} />

                  <box paddingTop={1} flexDirection="row">
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                      onMouseUp={activate}
                    >
                      <text fg={theme.background} attributes={TextAttributes.BOLD}>
                        {busy() ? "Activating…" : "→ Activate"}
                      </text>
                    </box>
                  </box>

                  <box paddingTop={2}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Lite — $10/mo
                    </text>
                  </box>
                  <text fg={theme.textMuted}>• 15 saved strategies, 20 backtests/day</text>
                  <text fg={theme.textMuted}>• Live trading on Alpaca, Polymarket, Binance</text>
                  <text fg={theme.textMuted}>• 5 terminal + 3 cloud live runs</text>
                  <text fg={theme.textMuted}>• Discord Lite badge</text>

                  <box paddingTop={2}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Pro ★ most popular
                    </text>
                  </box>
                  <text fg={theme.textMuted}>• Unlimited strategies + backtests</text>
                  <text fg={theme.textMuted}>• All brokers (incl. Questrade, IBKR)</text>
                  <text fg={theme.textMuted}>• Unlimited terminal runs + 5 cloud runs</text>
                  <text fg={theme.textMuted}>• Telegram bot, analytics, TradingView webhooks</text>
                </box>
              </scrollbox>
            </Card>
          }
        >
          <Card title={tier() === "pro" ? " Finny Pro " : " Finny Lite "}>
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
              <box flexDirection="column" gap={1}>
                <text fg={theme.success} attributes={TextAttributes.BOLD}>
                  {tier() === "pro" ? "Pro is active" : "Lite is active"}
                </text>
                <Show when={tier() === "pro" && proKey()}>
                  <text fg={theme.textMuted}>Pro license: {Plan.maskKey(proKey()!)}</text>
                </Show>
                <Show when={tier() === "lite" && liteKey()}>
                  <text fg={theme.textMuted}>Lite license: {Plan.maskKey(liteKey()!)}</text>
                </Show>

                <box paddingTop={1} flexDirection="row" gap={2}>
                  <box paddingLeft={1} paddingRight={1} onMouseUp={() => removeLicense(tier() as Exclude<Plan.Tier, "free">)}>
                    <text fg={theme.error}>Remove license</text>
                  </box>
                </box>

                <Show when={tier() === "lite"}>
                  <box paddingTop={2}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Upgrade to Pro
                    </text>
                  </box>
                  <text fg={theme.textMuted}>
                    Unlock unlimited strategies, all brokers, Telegram bot, and more.
                  </text>
                  <box flexDirection="row">
                    <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={openPro}>
                      <text fg={theme.background} attributes={TextAttributes.BOLD}>
                        → Upgrade to Pro
                      </text>
                    </box>
                  </box>
                </Show>

                <Show when={tier() === "pro"}>
                  <box paddingTop={2}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Managed Hosting
                    </text>
                  </box>
                  <text fg={theme.textMuted}>
                    Deploy your algo on our infrastructure with Telegram monitoring.
                  </text>
                  <box flexDirection="row">
                    <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={() => DialogManagedHosting.show(dialog)}>
                      <text fg={theme.background} attributes={TextAttributes.BOLD}>
                        → Request Managed Hosting
                      </text>
                    </box>
                  </box>
                </Show>

                <box paddingTop={2}>
                  <text fg={theme.textMuted}>
                    Have a different license code? Paste it below to switch.
                  </text>
                </box>
                <InputBox onInput={setLicenseInput} />
                <box flexDirection="row">
                  <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                    onMouseUp={activate}
                  >
                    <text fg={theme.background} attributes={TextAttributes.BOLD}>
                      {busy() ? "Activating…" : "→ Activate"}
                    </text>
                  </box>
                </box>
              </box>
            </scrollbox>
          </Card>
        </Show>
      </box>
    </box>
  )
}
