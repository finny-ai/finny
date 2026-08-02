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
import { ForegroundCommandError, runForegroundInteractiveCommand } from "../util/foreground-command"
import {
  canRunRobinhoodLoginLocally,
  canSelectRobinhood,
  createRobinhoodIntegrationClient,
  managedRobinhoodLoginCommand,
  ROBINHOOD_CRYPTO_URL,
  type RobinhoodConnectionStatus,
  type RobinhoodIntegrationOptions,
  type RobinhoodIntegrationStatus,
} from "../util/robinhood-integration"

type BusyAction = "loading" | "installing" | "connecting" | "verifying" | "disconnecting"
type LoginCommand = { command: string; args: string[] }

const RHX_PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function connectionLabel(value: RobinhoodConnectionStatus) {
  if (value.ready) return "Ready"
  if (value.state === "mfa_required") return "MFA required"
  if (value.state === "expired") return "Session expired"
  if (value.state === "configured") return "Configured · verify"
  if (value.state === "error") return "Needs attention"
  return "Not configured"
}

function selectedProfile(value: string) {
  return value.trim() || "default"
}

function requiresManualPath(input: {
  current?: RobinhoodIntegrationStatus
  useManualPath: boolean
  manualPath: string
}) {
  return [
    input.current?.supported === false,
    input.current?.source === "manual",
    input.useManualPath,
    input.manualPath.length > 0,
  ].some(Boolean)
}

function resolveExecutablePath(manualPath: string, current?: RobinhoodIntegrationStatus) {
  const executablePath = manualPath || current?.executablePath || ""
  if (!path.isAbsolute(executablePath)) throw new Error("Enter an absolute path to the RHX executable")
  return executablePath
}

function integrationOptions(input: {
  current?: RobinhoodIntegrationStatus
  profile: string
  manualPath: string
  useManualPath: boolean
}): RobinhoodIntegrationOptions {
  const profile = selectedProfile(input.profile)
  const manualPath = input.manualPath.trim()
  if (!requiresManualPath({ current: input.current, useManualPath: input.useManualPath, manualPath }))
    return { profile }
  return { executablePath: resolveExecutablePath(manualPath, input.current), profile }
}

function integrationChanged(current: RobinhoodIntegrationStatus, input: RobinhoodIntegrationOptions) {
  const profileChanged = (input.profile ?? "default") !== (current.profile ?? "default")
  const executableChanged = !!input.executablePath && input.executablePath !== current.executablePath
  return profileChanged || executableChanged
}

function ensureLocalLogin(canRunLogin: boolean) {
  if (canRunLogin) return
  throw new Error(
    "Interactive RHX login is disabled for remote Finny servers. Run `rhx --profile <profile> auth login` on the server, then choose Verify.",
  )
}

function ensureInstalled(current: RobinhoodIntegrationStatus) {
  if (current.installed && current.status !== "error") return
  throw new Error(current.message || "RHX must be installed before login")
}

function validatedProfile(value?: string) {
  const profile = selectedProfile(value ?? "default")
  if (!RHX_PROFILE_PATTERN.test(profile)) throw new Error("Enter a valid RHX profile")
  return profile
}

function connectionFailureMessage(verified: RobinhoodIntegrationStatus, loginError: unknown) {
  if (verified.message) return verified.message
  return loginError instanceof Error ? loginError.message : "RHX login was not verified"
}

function connectionSuccessMessage(status: RobinhoodIntegrationStatus) {
  return status.brokerage.ready ? "Robinhood stocks & ETFs connected" : "Robinhood crypto connected"
}

async function loginCommand(input: {
  status: Pick<RobinhoodIntegrationStatus, "package" | "pinnedVersion">
  options: RobinhoodIntegrationOptions
  profile: string
  manualPathConfirmed: boolean
}): Promise<LoginCommand> {
  // Never execute argv returned by the HTTP server. A loopback URL can be an
  // SSH-forwarded remote endpoint, so the login command must come from this
  // workstation's pinned package cache or an explicitly typed path.
  if (input.options.executablePath) {
    if (!input.manualPathConfirmed) {
      throw new Error("Re-enter the local RHX executable path before interactive login")
    }
    return {
      command: input.options.executablePath,
      args: ["--profile", input.profile, "auth", "login"],
    }
  }

  const pinnedVersion = input.status.pinnedVersion.trim()
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinnedVersion)) {
    throw new Error("The server returned an invalid RHX package version")
  }
  const installed = await Npm.add(`${input.status.package}@${pinnedVersion}`)
  const local = managedRobinhoodLoginCommand({ packageDirectory: installed.directory, profile: input.profile })
  await fs.access(local.entrypoint)
  return local
}

function Action(props: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  danger?: boolean
}) {
  const { theme } = useTheme()
  const background = () => (props.disabled || !props.primary ? theme.backgroundElement : theme.primary)
  const foreground = () => {
    if (props.disabled) return theme.textMuted
    if (props.primary) return theme.background
    if (props.danger) return theme.error
    return theme.text
  }

  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      height={1}
      flexShrink={0}
      backgroundColor={props.disabled ? theme.borderSubtle : background()}
      onMouseUp={() => {
        if (!props.disabled) props.onClick()
      }}
    >
      <text fg={foreground()} attributes={TextAttributes.BOLD}>
        {props.label}
      </text>
    </box>
  )
}

function TextInput(props: { value: string; placeholder: string; onInput: (value: string) => void }) {
  const { theme } = useTheme()
  return (
    <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1} height={1} flexShrink={0}>
      <input
        value={props.value}
        placeholder={props.placeholder}
        onInput={props.onInput}
        onMouseDown={(event: MouseEvent) => event.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        focusedTextColor={theme.text}
        cursorColor={theme.primary}
      />
    </box>
  )
}

function connectorStateLabel(current: RobinhoodIntegrationStatus) {
  if (current.installed) return "Installed"
  return current.supported ? "Not installed" : "Manual path required"
}

function connectActionLabel(current: RobinhoodIntegrationStatus, busy?: BusyAction) {
  if (busy === "connecting") return "Connecting…"
  return current.brokerage.ready ? "Reconnect Robinhood" : "Connect Robinhood"
}

type ConnectorSectionProps = {
  current: RobinhoodIntegrationStatus
  busy?: BusyAction
  profile: string
  manualPath: string
  useManualPath: boolean
  canRunLogin: boolean
  onProfileInput: (value: string) => void
  onManualPathInput: (value: string) => void
  onToggleManualPath: () => void
  onInstall: () => void
  onConnect: () => void
  onVerify: () => void
  onRefresh: () => void
}

function ConnectorHeader(props: { current: RobinhoodIntegrationStatus }) {
  const { theme } = useTheme()
  const stateColor = () => {
    if (props.current.installed) return theme.success
    return props.current.supported ? theme.warning : theme.error
  }

  return (
    <box flexDirection="row" justifyContent="space-between" gap={2}>
      <box flexDirection="column" flexGrow={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Robinhood connector
        </text>
        <text fg={theme.textMuted}>
          Pinned RHX connector · v{props.current.pinnedVersion} · credentials stay in RHX
        </text>
        <text fg={theme.info}>
          Shadow-only in this release · account data is read-only and Finny does not submit Robinhood orders
        </text>
      </box>
      <text fg={stateColor()} attributes={TextAttributes.BOLD}>
        {connectorStateLabel(props.current)}
      </text>
    </box>
  )
}

function ConnectorConfiguration(
  props: Pick<
    ConnectorSectionProps,
    "current" | "profile" | "manualPath" | "useManualPath" | "onProfileInput" | "onManualPathInput"
  >,
) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="column" gap={0}>
        <text fg={theme.textMuted}>RHX profile (not a credential)</text>
        <TextInput value={props.profile} placeholder="default" onInput={props.onProfileInput} />
      </box>

      <Show when={!props.current.supported || props.current.source === "manual" || props.useManualPath}>
        <box flexDirection="column" gap={0}>
          <text fg={theme.warning}>
            {props.current.supported
              ? "Use an existing RHX binary by entering its absolute path."
              : "This platform needs an existing RHX binary. Enter its absolute path."}
          </text>
          <TextInput value={props.manualPath} placeholder="/absolute/path/to/rhx" onInput={props.onManualPathInput} />
        </box>
      </Show>
    </>
  )
}

function ConnectorActions(
  props: Pick<
    ConnectorSectionProps,
    | "current"
    | "busy"
    | "useManualPath"
    | "canRunLogin"
    | "onToggleManualPath"
    | "onInstall"
    | "onConnect"
    | "onVerify"
    | "onRefresh"
  >,
) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} flexWrap="wrap">
        <Show
          when={props.current.installed}
          fallback={
            <Action
              label={props.busy === "installing" ? "Installing…" : "Install Robinhood"}
              primary
              disabled={!!props.busy}
              onClick={props.onInstall}
            />
          }
        >
          <Action
            label={connectActionLabel(props.current, props.busy)}
            primary
            disabled={!!props.busy || !props.canRunLogin}
            onClick={props.onConnect}
          />
          <Action
            label={props.busy === "verifying" ? "Verifying…" : "Verify"}
            disabled={!!props.busy}
            onClick={props.onVerify}
          />
        </Show>
        <Show when={!props.current.installed && props.current.supported}>
          <Action
            label={props.useManualPath ? "Use pinned install" : "Use existing RHX"}
            disabled={!!props.busy}
            onClick={props.onToggleManualPath}
          />
        </Show>
        <Action label="Refresh" disabled={!!props.busy} onClick={props.onRefresh} />
      </box>
      <Show when={!props.canRunLogin}>
        <text fg={theme.warning}>
          Remote server attached: Finny will not execute a server-provided RHX path on this computer. Run RHX login on
          the server, then Verify here.
        </text>
      </Show>
    </>
  )
}

function ConnectorSection(props: ConnectorSectionProps) {
  const { theme } = useTheme()
  return (
    <box border={["left"]} borderColor={theme.primary} paddingLeft={2} flexDirection="column" gap={1}>
      <ConnectorHeader current={props.current} />
      <ConnectorConfiguration
        current={props.current}
        profile={props.profile}
        manualPath={props.manualPath}
        useManualPath={props.useManualPath}
        onProfileInput={props.onProfileInput}
        onManualPathInput={props.onManualPathInput}
      />
      <ConnectorActions
        current={props.current}
        busy={props.busy}
        useManualPath={props.useManualPath}
        canRunLogin={props.canRunLogin}
        onToggleManualPath={props.onToggleManualPath}
        onInstall={props.onInstall}
        onConnect={props.onConnect}
        onVerify={props.onVerify}
        onRefresh={props.onRefresh}
      />
    </box>
  )
}

function BrokerageSection(props: { status: RobinhoodConnectionStatus }) {
  const { theme } = useTheme()
  return (
    <box border={["left"]} borderColor={theme.warning} paddingLeft={2} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <box flexDirection="column" flexGrow={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Stocks & ETFs · Beta
          </text>
          <text fg={theme.textMuted}>Unofficial RHX brokerage endpoints may change without notice.</text>
        </box>
        <text fg={props.status.ready ? theme.success : theme.warning} attributes={TextAttributes.BOLD}>
          {connectionLabel(props.status)}
        </text>
      </box>
      <text fg={theme.textMuted}>
        RHX owns username, password, MFA, and session storage. Finny never asks for or stores them.
      </text>
    </box>
  )
}

function CryptoSection(props: {
  status: RobinhoodConnectionStatus
  installed: boolean
  busy?: BusyAction
  onOpenSetup: () => void
  onVerify: () => void
}) {
  const { theme } = useTheme()
  const stateColor = () => {
    if (props.status.ready) return theme.success
    return props.status.configured ? theme.warning : theme.textMuted
  }

  return (
    <box border={["left"]} borderColor={theme.success} paddingLeft={2} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <box flexDirection="column" flexGrow={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Crypto · Official API
          </text>
          <text fg={theme.textMuted}>Robinhood Crypto Trading API · USD pairs</text>
        </box>
        <text fg={stateColor()} attributes={TextAttributes.BOLD}>
          {connectionLabel(props.status)}
        </text>
      </box>
      <text fg={theme.textMuted}>
        API setup is separate and not yet one-click in Finny. Crypto is Ready only when RHX can read its OS keyring;
        env-only keys are never passed into strategy workers.
      </text>
      <box flexDirection="row" gap={1}>
        <Action label="Open official Crypto API setup" onClick={props.onOpenSetup} />
        <Show when={props.installed}>
          <Action label="Recheck" disabled={!!props.busy} onClick={props.onVerify} />
        </Show>
      </box>
    </box>
  )
}

function DisconnectSection(props: { busy?: BusyAction; onDisconnect: () => void }) {
  const { theme } = useTheme()
  return (
    <box border={["left"]} borderColor={theme.error} paddingLeft={2} flexDirection="column" gap={1}>
      <text fg={theme.textMuted}>
        Remove detaches Robinhood from Finny only. It does not delete RHX credentials or sessions from the OS keychain,
        or the npm cache.
      </text>
      <box flexDirection="row">
        <Action
          label={props.busy === "disconnecting" ? "Removing…" : "Remove from Finny"}
          danger
          disabled={!!props.busy}
          onClick={props.onDisconnect}
        />
      </box>
    </box>
  )
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

  function currentOptions(current?: RobinhoodIntegrationStatus) {
    return integrationOptions({
      current,
      profile: profile(),
      manualPath: manualPath(),
      useManualPath: useManualPath(),
    })
  }

  async function selectRobinhood(next: RobinhoodIntegrationStatus) {
    if (!canSelectRobinhood(next)) return false
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
      const next = await client.install(currentOptions(current))
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

  async function installForLogin(current: RobinhoodIntegrationStatus, input: RobinhoodIntegrationOptions) {
    if (current.installed && !integrationChanged(current, input)) return current
    const next = await client.install(input)
    applyStatus(next)
    return next
  }

  async function runLogin(command: LoginCommand) {
    try {
      await runForegroundInteractiveCommand({ renderer, command: command.command, args: command.args })
      return undefined
    } catch (cause) {
      if (cause instanceof ForegroundCommandError && cause.cancelled) throw cause
      return cause
    }
  }

  async function connectBrokerageSession(initial: RobinhoodIntegrationStatus) {
    ensureLocalLogin(canRunLogin())
    const input = currentOptions(initial)
    const current = await installForLogin(initial, input)
    ensureInstalled(current)
    const profile = validatedProfile(input.profile)
    const command = await loginCommand({
      status: current,
      options: input,
      profile,
      manualPathConfirmed: manualPathTouched,
    })
    const loginError = await runLogin(command)
    const verified = await client.verify(input)
    applyStatus(verified)
    if (await selectRobinhood(verified)) {
      toast.show({ message: connectionSuccessMessage(verified), variant: "success", duration: 4000 })
      return
    }
    throw new Error(connectionFailureMessage(verified, loginError))
  }

  function handleConnectionError(cause: unknown) {
    if (cause instanceof ForegroundCommandError && cause.cancelled) {
      toast.show({ message: "Robinhood login cancelled", variant: "info", duration: 3000 })
      return
    }
    showError("Robinhood connection failed", cause)
  }

  async function connectBrokerage() {
    const current = status()
    if (!current || busy()) return
    setBusy("connecting")
    setError(undefined)
    try {
      await connectBrokerageSession(current)
    } catch (cause) {
      handleConnectionError(cause)
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
      const next = await client.verify(currentOptions(current))
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

  function toggleManualPath() {
    const next = !useManualPath()
    setUseManualPath(next)
    if (next) return
    manualPathTouched = false
    setManualPath("")
  }

  return (
    <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
      <box flexDirection="column" gap={1} paddingRight={1}>
        <Show
          when={status()}
          fallback={<text fg={theme.textMuted}>{busy() ? "Loading Robinhood…" : "Status unavailable"}</text>}
        >
          {(current) => (
            <>
              <ConnectorSection
                current={current()}
                busy={busy()}
                profile={profile()}
                manualPath={manualPath()}
                useManualPath={useManualPath()}
                canRunLogin={canRunLogin()}
                onProfileInput={(value) => {
                  profileTouched = true
                  setProfile(value)
                }}
                onManualPathInput={(value) => {
                  manualPathTouched = true
                  setManualPath(value)
                }}
                onToggleManualPath={toggleManualPath}
                onInstall={() => void installConnector()}
                onConnect={() => void connectBrokerage()}
                onVerify={() => void verifyBrokerage()}
                onRefresh={() => void load()}
              />

              <BrokerageSection status={current().brokerage} />

              <CryptoSection
                status={current().crypto}
                installed={current().installed}
                busy={busy()}
                onOpenSetup={() => void openCryptoSetup()}
                onVerify={() => void verifyBrokerage()}
              />

              <Show when={current().installed || current().brokerage.configured}>
                <DisconnectSection busy={busy()} onDisconnect={() => void disconnect()} />
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
