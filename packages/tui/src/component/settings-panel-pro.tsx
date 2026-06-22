import { createSignal, onMount, Show } from "solid-js"
import { TextAttributes, MouseEvent } from "@opentui/core"
import { finnyEnterpriseEnabled, finnyProductName } from "@/cloud-mode"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { Card } from "./card"
import { License } from "@/license"

type LicenseStatus = Awaited<ReturnType<typeof License.currentStatus>>

function planLabel(status: LicenseStatus | null) {
  if (!status?.plan_type) return "Enterprise"
  if (status.plan_type === "enterprise") return "Enterprise"
  return "Enterprise Per-Head"
}

function formatDate(value?: string) {
  if (!value) return "Not checked"
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return "Unknown"
  return new Date(parsed).toLocaleString()
}

function shortHash(value?: string) {
  if (!value) return "Unavailable"
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

function deviceUsage(status: LicenseStatus | null) {
  if (status?.plan_type === "enterprise") return "Unlimited"
  if (!status?.device_limit) return "Available after next verification"
  return `${status.devices_used ?? 0} / ${status.device_limit}`
}

export function SettingsPanelPro() {
  const { theme } = useTheme()
  const toast = useToast()
  const enterprise = finnyEnterpriseEnabled()
  const productName = finnyProductName()
  const licenseTitle = enterprise ? "Enterprise license key" : "Finny license key"
  const licenseName = enterprise ? "enterprise license key" : "Finny license key"

  const [status, setStatus] = createSignal<LicenseStatus | null>(null)
  const [licenseInput, setLicenseInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    setStatus(await License.currentStatus())
  }

  onMount(refresh)

  const activate = async () => {
    if (busy()) return
    const key = licenseInput().trim()
    if (!key) {
      toast.show({ message: `Please enter ${enterprise ? "an" : "a"} ${licenseName}`, variant: "warning", duration: 3000 })
      return
    }
    setBusy(true)
    try {
      await License.activate(key)
      setLicenseInput("")
      await refresh()
      toast.show({ message: `${productName} license verified`, variant: "info", duration: 3000 })
    } catch (e) {
      const message = e instanceof Error ? e.message : "Access denied. Please contact Finny."
      toast.show({ message, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const InputBox = (props: { onInput: (v: string) => void }) => (
    <box
      border={["top", "right", "bottom", "left"]}
      borderColor={theme.border}
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={3}
      flexShrink={0}
    >
      <input
        placeholder="Paste license key"
        placeholderColor={theme.textMuted}
        onInput={(v: string) => props.onInput(v)}
        onMouseDown={(r: MouseEvent) => r.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
      />
    </box>
  )

  const Row = (props: { label: string; value: string; accent?: boolean }) => (
    <box flexDirection="row" gap={2}>
      <text fg={theme.textMuted}>{props.label.padEnd(16)}</text>
      <text fg={props.accent ? theme.success : theme.text} attributes={props.accent ? TextAttributes.BOLD : undefined}>
        {props.value}
      </text>
    </box>
  )

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      <box width={36} flexShrink={0} minHeight={0}>
        <Card title=" Plan ">
          <box flexDirection="column" gap={1}>
            <box flexDirection="row" gap={1}>
              <text fg={status()?.active ? theme.success : theme.textMuted}>{status()?.active ? "✓" : "○"}</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {enterprise ? planLabel(status()) : productName}
              </text>
            </box>
            <text fg={theme.textMuted}>Local install license</text>
            <text fg={theme.textMuted}>Daily server verification</text>
            <text fg={theme.textMuted}>No prompts, strategy code, market data, backtest results, or P&L leave this machine.</text>
          </box>
        </Card>
      </box>

      <box flexGrow={1} minHeight={0}>
        <Card title={` ${enterprise ? `Finny ${planLabel(status())}` : productName} `}>
          <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
            <text fg={status()?.active ? theme.success : theme.error} attributes={TextAttributes.BOLD}>
              {status()?.active ? "License is active" : "License verification required"}
            </text>

            <Row label="Organization" value={status()?.org_id ?? "dv_trading"} />
            <Row label="Plan" value={planLabel(status())} accent={status()?.active} />
            <Row label="Device usage" value={deviceUsage(status())} />
            <Row label="Machine hash" value={shortHash(status()?.machine_id_hash)} />
            <Row label="License hash" value={shortHash(status()?.license_key_hash)} />
            <Row label="Last verified" value={formatDate(status()?.last_ok_at)} />
            <Row label="Next check" value={formatDate(status()?.next_check_after)} />

            <box paddingTop={2}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {licenseTitle}
              </text>
            </box>
            <text fg={theme.textMuted}>
              Enter a new {licenseName} only if Finny asks you to rotate this installation.
            </text>
            <box maxWidth={64}>
              <InputBox onInput={setLicenseInput} />
            </box>

            <box flexDirection="row" paddingTop={1}>
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                onMouseUp={activate}
              >
                <text fg={theme.background} attributes={TextAttributes.BOLD}>
                  {busy() ? "Verifying..." : "Verify license"}
                </text>
              </box>
            </box>

            <Show when={status()?.active}>
              <box paddingTop={2}>
                <text fg={theme.textMuted}>
                  Finny is unlocked on this machine. Restricted build, validation, backtest, export, and adapter actions
                  remain available while the daily check is fresh.
                </text>
              </box>
            </Show>
          </box>
        </Card>
      </box>
    </box>
  )
}
