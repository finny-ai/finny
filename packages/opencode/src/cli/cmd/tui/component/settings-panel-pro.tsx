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

export function SettingsPanelPro() {
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()

  const [proActive, setProActive] = createSignal(false)
  const [maskedKey, setMaskedKey] = createSignal("")
  const [licenseInput, setLicenseInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    const active = await Plan.isPro()
    setProActive(active)
    if (active) {
      const key = await Plan.getLicenseKey()
      setMaskedKey(key ? Plan.maskKey(key) : "")
    }
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
      await Plan.setLicenseKey(key)
      const valid = await Plan.isPro()
      if (!valid) {
        await Plan.removeLicenseKey()
        toast.show({ message: "Invalid license code. Check your code and try again.", variant: "error", duration: 5000 })
      } else {
        toast.show({ message: "Finny Pro activated!", variant: "info", duration: 4000 })
        setLicenseInput("")
        await refresh()
      }
    } catch (e: any) {
      toast.show({ message: `Error: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const removeLicense = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await Plan.removeLicenseKey()
      toast.show({ message: "License removed", variant: "info", duration: 3000 })
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

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      {/* Left pane — plan status */}
      <box width={36} flexShrink={0} minHeight={0}>
        <Card title=" Plan ">
          <box flexDirection="column" gap={2}>
            <box flexDirection="column" gap={0}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                ◆ Finny Pro
              </text>
              <Show
                when={proActive()}
                fallback={
                  <text fg={theme.warning}>○ Free plan</text>
                }
              >
                <text fg={theme.success} attributes={TextAttributes.BOLD}>
                  ✓ Active
                </text>
              </Show>
            </box>

            <box
              paddingLeft={1}
              paddingRight={1}
              flexDirection="row"
              onMouseUp={() => {
                open(PRO_URL).catch(() => {
                  toast.show({ message: PRO_URL, variant: "info", duration: 5000 })
                })
                toast.show({ message: "Opening Pro page in browser…", variant: "info", duration: 2000 })
              }}
            >
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                → Buy Pro at finnyai.tech
              </text>
            </box>
          </box>
        </Card>
      </box>

      {/* Right pane */}
      <box flexGrow={1} minHeight={0}>
        <Show
          when={proActive()}
          fallback={
            <Card title=" Activate Pro ">
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
                <box flexDirection="column" gap={1}>
                  <text fg={theme.textMuted}>
                    Paste the license code you received after purchase.
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
                      What's included in Pro
                    </text>
                  </box>
                  <text fg={theme.textMuted}>• Extended backtests — 6-month and 1-year durations</text>
                  <text fg={theme.textMuted}>• Unlimited live algos — run multiple strategies simultaneously</text>
                  <text fg={theme.textMuted}>• Managed hosting — we deploy your algo on our infrastructure</text>
                  <text fg={theme.textMuted}>• Premium AI models — access to more powerful models</text>
                  <text fg={theme.textMuted}>• Telegram monitoring — real-time bot for your live algos</text>
                </box>
              </scrollbox>
            </Card>
          }
        >
          <Card title=" Finny Pro ">
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
              <box flexDirection="column" gap={1}>
                <text fg={theme.success} attributes={TextAttributes.BOLD}>
                  Pro is active
                </text>
                <text fg={theme.textMuted}>
                  License: {maskedKey()}
                </text>

                <box paddingTop={1} flexDirection="row" gap={2}>
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={removeLicense}
                  >
                    <text fg={theme.error}>Remove license</text>
                  </box>
                </box>

                <box paddingTop={2}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    Managed Hosting
                  </text>
                </box>
                <text fg={theme.textMuted}>
                  Deploy your algo on our infrastructure with Telegram monitoring.
                </text>
                <box flexDirection="row">
                  <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={theme.primary}
                    onMouseUp={() => DialogManagedHosting.show(dialog)}
                  >
                    <text fg={theme.background} attributes={TextAttributes.BOLD}>
                      → Request Managed Hosting
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
