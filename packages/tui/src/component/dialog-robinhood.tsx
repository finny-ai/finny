import { MouseEvent, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Npm } from "@opencode-ai/core/npm"
import fs from "node:fs/promises"
import path from "node:path"
import open from "open"
import { createSignal, onMount, Show } from "solid-js"
import { useLocal } from "../context/local"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { runForegroundInteractiveCommand } from "../util/foreground-command"
import {
  canRunRobinhoodLoginLocally,
  createRobinhoodIntegrationClient,
  managedRobinhoodLoginCommand,
  ROBINHOOD_CRYPTO_URL,
  type RobinhoodConnectionStatus,
  type RobinhoodIntegrationOptions,
  type RobinhoodIntegrationStatus,
} from "../util/robinhood-integration"

type BusyAction = "loading" | "installing" | "connecting" | "verifying" | "disconnecting"

function connectionLabel(value: RobinhoodConnectionStatus) {
  if (value.ready) return "Ready"
  if (value.state === "mfa_required") return "MFA required"
  if (value.state === "expired") return "Session expired"
  if (value.state === "configured") return "Configured · verify"
  if (value.state === "error") return "Needs attention"
  return "Not configured"
}

export function RobinhoodManager(props: { onChanged?: () => void } = {}) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()
  const renderer = useRenderer()
  const local = useLocal()
  const client = createRobinhoodIntegrationClient(sdk)
  const canRunLogin = () => canRunRobinhoodLoginLocally(sdk.url)

  const [status, setStatus] = createSignal<RobinhoodIntegrationStatus>()
  const [busy, setBusy] = createSignal<BusyAction>()
  const [error, setError] = createSignal<string>()
  const [profile, setProfile] = createSignal("default")
  const [manualPath, setManualPath] = createSignal("")
  const [useManualPath, setUseManualPath] = createSignal(false)
  let profileTouched = false
  let manualPathTouched = false

  function applyStatus(next: RobinhoodIntegrationStatus) {
    setStatus(next)
    if (!profileTouched) setProfile(next.profile || "default")
    if (next.source === "manual") {
      setUseManualPath(true)
      if (!manualPathTouched) setManualPath(next.executablePath || "")
    }
  }

  function showError(prefix: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    setError(`${prefix}: ${detail}`)
  }

  async function load() {
    if (busy()) return
    setBusy("loading")
    setError(undefined)
    try {
      applyStatus(await client.status())
    } catch (cause) {
      showError("Unable to load Robinhood status", cause)
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => void load())

  function options(current?: RobinhoodIntegrationStatus): RobinhoodIntegrationOptions {
    const selectedProfile = profile().trim() || "default"
    const selectedPath = manualPath().trim()
    const needsManualPath =
      current?.supported === false || current?.source === "manual" || useManualPath() || selectedPath.length > 0
    if (needsManualPath) {
      const executablePath = selectedPath || current?.executablePath || ""
      if (!path.isAbsolute(executablePath)) {
        throw new Error("Enter an absolute path to the RHX executable")
      }
      return { executablePath, profile: selectedProfile }
    }
    return { profile: selectedProfile }
  }

  async function selectRobinhood(next: RobinhoodIntegrationStatus) {
    if (!next.brokerage.ready) return false
    await local.brokerage.set("robinhood")
    props.onChanged?.()
    return true
  }

  async function installConnector() {
    const current = status()
    if (!current || busy()) return
    setBusy("installing")
    setError(undefined)
    try {
      const next = await client.install(options(current))
      applyStatus(next)
      props.onChanged?.()
      if (!next.installed || next.status === "error") {
        setError(next.message || "Pinned RHX installation did not complete.")
        return
      }
      toast.show({
        message: `Installed pinned RHX connector v${next.pinnedVersion}`,
        variant: "success",
        duration: 4000,
      })
    } catch (cause) {
      showError("Robinhood install failed", cause)
    } finally {
      setBusy(undefined)
    }
  }

  async function connectBrokerage() {
    let current = status()
    if (!current || busy()) return
    setBusy("connecting")
    setError(undefined)
    try {
      if (!canRunLogin()) {
        throw new Error(
          "Interactive RHX login is disabled for remote Finny servers. Run `rhx --profile <profile> auth login` on the server, then choose Verify.",
        )
      }
      const input = options(current)
      const changed =
        (input.profile ?? "default") !== (current.profile ?? "default") ||
        (!!input.executablePath && input.executablePath !== current.executablePath)
      if (!current.installed || changed) {
        current = await client.install(input)
        applyStatus(current)
      }
      if (!current.installed || current.status === "error") {
        throw new Error(current.message || "RHX must be installed before login")
      }

      const selectedProfile = profile().trim() || "default"
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(selectedProfile)) throw new Error("Enter a valid RHX profile")

      // Never execute argv returned by the HTTP server. A loopback URL can be
      // an SSH-forwarded remote endpoint, so the login command must come from
      // this workstation's pinned package cache or an explicitly typed path.
      let command: string
      let args: string[]
      if (input.executablePath) {
        if (!manualPathTouched) {
          throw new Error("Re-enter the local RHX executable path before interactive login")
        }
        command = input.executablePath
        args = ["--profile", selectedProfile, "auth", "login"]
      } else {
        const installed = await Npm.add("rhx@0.4.8")
        const local = managedRobinhoodLoginCommand({ packageDirectory: installed.directory, profile: selectedProfile })
        await fs.access(local.entrypoint)
        command = local.command
        args = local.args
      }

      let loginError: unknown
      try {
        await runForegroundInteractiveCommand({
          renderer,
          command,
          args,
        })
      } catch (cause) {
        loginError = cause
      }

      const verified = await client.verify(input)
      applyStatus(verified)
      if (await selectRobinhood(verified)) {
        toast.show({ message: "Robinhood stocks & ETFs connected", variant: "success", duration: 4000 })
        return
      }
      throw new Error(
        verified.message || (loginError instanceof Error ? loginError.message : "RHX login was not verified"),
      )
    } catch (cause) {
      showError("Robinhood connection failed", cause)
    } finally {
      setBusy(undefined)
    }
  }

  async function verifyBrokerage() {
    const current = status()
    if (!current || busy()) return
    setBusy("verifying")
    setError(undefined)
    try {
      const next = await client.verify(options(current))
      applyStatus(next)
      if (await selectRobinhood(next)) {
        toast.show({ message: "Robinhood connection verified", variant: "success", duration: 3500 })
        return
      }
      setError(next.message || `Robinhood verification returned ${connectionLabel(next.brokerage).toLowerCase()}`)
    } catch (cause) {
      showError("Robinhood verification failed", cause)
    } finally {
      setBusy(undefined)
    }
  }

  async function disconnect() {
    if (busy()) return
    setBusy("disconnecting")
    setError(undefined)
    try {
      const next = await client.disconnect()
      applyStatus(next)
      if (next.status === "error" || next.installed) {
        setError(next.message || "Robinhood could not be removed from Finny.")
        return
      }
      await local.brokerage.clear("robinhood")
      props.onChanged?.()
      toast.show({
        message: "Removed Robinhood from Finny. RHX credentials, sessions, and npm cache were left intact.",
        variant: "info",
        duration: 6000,
      })
    } catch (cause) {
      showError("Unable to remove Robinhood from Finny", cause)
    } finally {
      setBusy(undefined)
    }
  }

  async function openCryptoSetup() {
    try {
      await open(ROBINHOOD_CRYPTO_URL)
      toast.show({ message: "Opened Robinhood Crypto API setup", variant: "info", duration: 3000 })
    } catch (cause) {
      showError("Unable to open Robinhood Crypto API setup", cause)
    }
  }

  const Action = (actionProps: {
    label: string
    onClick: () => void
    disabled?: boolean
    primary?: boolean
    danger?: boolean
  }) => (
    <box
      paddingLeft={2}
      paddingRight={2}
      height={1}
      flexShrink={0}
      backgroundColor={
        actionProps.disabled
          ? theme.borderSubtle
          : actionProps.primary
            ? theme.primary
            : actionProps.danger
              ? theme.backgroundElement
              : theme.backgroundElement
      }
      onMouseUp={() => {
        if (!actionProps.disabled) actionProps.onClick()
      }}
    >
      <text
        fg={
          actionProps.disabled
            ? theme.textMuted
            : actionProps.primary
              ? theme.background
              : actionProps.danger
                ? theme.error
                : theme.text
        }
        attributes={TextAttributes.BOLD}
      >
        {actionProps.label}
      </text>
    </box>
  )

  const Input = (inputProps: { value: string; placeholder: string; onInput: (value: string) => void }) => (
    <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
      <input
        value={inputProps.value}
        placeholder={inputProps.placeholder}
        onInput={inputProps.onInput}
        onMouseDown={(event: MouseEvent) => event.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
      />
    </box>
  )

  return (
    <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
      <box flexDirection="column" gap={1} paddingRight={1}>
        <Show
          when={status()}
          fallback={<text fg={theme.textMuted}>{busy() ? "Loading Robinhood…" : "Status unavailable"}</text>}
        >
          {(current) => (
            <>
              <box border={["left"]} borderColor={theme.primary} paddingLeft={2} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between" gap={2}>
                  <box flexDirection="column" flexGrow={1}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Robinhood connector
                    </text>
                    <text fg={theme.textMuted}>
                      Pinned RHX connector · v{current().pinnedVersion} · credentials stay in RHX
                    </text>
                    <text fg={theme.info}>
                      Shadow-only in this release · account data is read-only and Finny does not submit Robinhood orders
                    </text>
                  </box>
                  <text
                    fg={current().installed ? theme.success : current().supported ? theme.warning : theme.error}
                    attributes={TextAttributes.BOLD}
                  >
                    {current().installed ? "Installed" : current().supported ? "Not installed" : "Manual path required"}
                  </text>
                </box>

                <box flexDirection="column" gap={0}>
                  <text fg={theme.textMuted}>RHX profile (not a credential)</text>
                  <Input
                    value={profile()}
                    placeholder="default"
                    onInput={(value) => {
                      profileTouched = true
                      setProfile(value)
                    }}
                  />
                </box>

                <Show when={!current().supported || current().source === "manual" || useManualPath()}>
                  <box flexDirection="column" gap={0}>
                    <text fg={theme.warning}>
                      {current().supported
                        ? "Use an existing RHX binary by entering its absolute path."
                        : "This platform needs an existing RHX binary. Enter its absolute path."}
                    </text>
                    <Input
                      value={manualPath()}
                      placeholder="/absolute/path/to/rhx"
                      onInput={(value) => {
                        manualPathTouched = true
                        setManualPath(value)
                      }}
                    />
                  </box>
                </Show>

                <box flexDirection="row" gap={1} flexWrap="wrap">
                  <Show
                    when={current().installed}
                    fallback={
                      <Action
                        label={busy() === "installing" ? "Installing…" : "Install Robinhood"}
                        primary
                        disabled={!!busy()}
                        onClick={() => void installConnector()}
                      />
                    }
                  >
                    <Action
                      label={
                        busy() === "connecting"
                          ? "Connecting…"
                          : current().brokerage.ready
                            ? "Reconnect Robinhood"
                            : "Connect Robinhood"
                      }
                      primary
                      disabled={!!busy() || !canRunLogin()}
                      onClick={() => void connectBrokerage()}
                    />
                    <Action
                      label={busy() === "verifying" ? "Verifying…" : "Verify"}
                      disabled={!!busy()}
                      onClick={() => void verifyBrokerage()}
                    />
                  </Show>
                  <Show when={!current().installed && current().supported}>
                    <Action
                      label={useManualPath() ? "Use pinned install" : "Use existing RHX"}
                      disabled={!!busy()}
                      onClick={() => {
                        const next = !useManualPath()
                        setUseManualPath(next)
                        if (!next) {
                          manualPathTouched = false
                          setManualPath("")
                        }
                      }}
                    />
                  </Show>
                  <Action label="Refresh" disabled={!!busy()} onClick={() => void load()} />
                </box>
                <Show when={!canRunLogin()}>
                  <text fg={theme.warning}>
                    Remote server attached: Finny will not execute a server-provided RHX path on this computer. Run RHX login on the server, then Verify here.
                  </text>
                </Show>
              </box>

              <box border={["left"]} borderColor={theme.warning} paddingLeft={2} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between" gap={2}>
                  <box flexDirection="column" flexGrow={1}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Stocks & ETFs · Beta
                    </text>
                    <text fg={theme.textMuted}>Unofficial RHX brokerage endpoints may change without notice.</text>
                  </box>
                  <text fg={current().brokerage.ready ? theme.success : theme.warning} attributes={TextAttributes.BOLD}>
                    {connectionLabel(current().brokerage)}
                  </text>
                </box>
                <text fg={theme.textMuted}>
                  RHX owns username, password, MFA, and session storage. Finny never asks for or stores them.
                </text>
              </box>

              <box border={["left"]} borderColor={theme.success} paddingLeft={2} flexDirection="column" gap={1}>
                <box flexDirection="row" justifyContent="space-between" gap={2}>
                  <box flexDirection="column" flexGrow={1}>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Crypto · Official API
                    </text>
                    <text fg={theme.textMuted}>Robinhood Crypto Trading API · USD pairs</text>
                  </box>
                  <text
                    fg={
                      current().crypto.ready
                        ? theme.success
                        : current().crypto.configured
                          ? theme.warning
                          : theme.textMuted
                    }
                    attributes={TextAttributes.BOLD}
                  >
                    {connectionLabel(current().crypto)}
                  </text>
                </box>
                <text fg={theme.textMuted}>
                  API setup is separate and not yet one-click in Finny. Crypto is Ready only when RHX can read its OS
                  keyring; env-only keys are never passed into strategy workers.
                </text>
                <box flexDirection="row" gap={1}>
                  <Action label="Open official Crypto API setup" onClick={() => void openCryptoSetup()} />
                  <Show when={current().installed}>
                    <Action label="Recheck" disabled={!!busy()} onClick={() => void verifyBrokerage()} />
                  </Show>
                </box>
              </box>

              <Show when={current().installed || current().brokerage.configured}>
                <box border={["left"]} borderColor={theme.error} paddingLeft={2} flexDirection="column" gap={1}>
                  <text fg={theme.textMuted}>
                    Remove detaches Robinhood from Finny only. It does not delete RHX credentials or sessions from the
                    OS keychain, or the npm cache.
                  </text>
                  <box flexDirection="row">
                    <Action
                      label={busy() === "disconnecting" ? "Removing…" : "Remove from Finny"}
                      danger
                      disabled={!!busy()}
                      onClick={() => void disconnect()}
                    />
                  </box>
                </box>
              </Show>

              <Show when={current().message}>
                <text fg={current().status === "error" ? theme.error : theme.textMuted}>{current().message}</text>
              </Show>
            </>
          )}
        </Show>

        <Show when={error()}>
          <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
            <text fg={theme.error} wrapMode="word">
              {error()}
            </text>
          </box>
        </Show>
      </box>
    </scrollbox>
  )
}

export function DialogRobinhood(props: { onChanged?: () => void } = {}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  onMount(() => dialog.setSize("large"))

  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      height={Math.max(18, Math.min(31, dimensions().height - 8))}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Manage Robinhood
          </text>
          <text fg={theme.textMuted}>RHX brokerage beta + official Robinhood Crypto API</text>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <RobinhoodManager onChanged={props.onChanged} />
    </box>
  )
}

DialogRobinhood.show = (dialog: DialogContext, options: { onChanged?: () => void } = {}) =>
  new Promise<void>((resolve) => {
    dialog.replace(() => <DialogRobinhood onChanged={options.onChanged} />, resolve)
  })
