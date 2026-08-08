import { createSignal, For } from "solid-js"
import { TextAttributes, MouseEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useDialog, type DialogContext } from "../ui/dialog"
import { BrokerRegistry, type BrokerConnection, type BrokerKind, type BrokerMode, type BrokerSpec } from "@/live/brokers"
import { SegmentedControl, type SegmentedOption } from "../ui/segmented-control"
import { Link } from "../ui/link"

function shortHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

type Fields = Record<string, string>

function initialFields(spec: BrokerSpec): Fields {
  const out: Fields = {}
  for (const f of spec.credentialFields) out[f.name] = f.default ?? ""
  // If the spec exposes mode-aware endpoints, seed the endpoint field from
  // the default mode so the value visible in the form matches the mode the
  // user is about to save under.
  if (spec.endpointForMode && out.mode) {
    out.endpoint = spec.endpointForMode(out.mode as BrokerMode, { connection: out.connection as BrokerConnection }) || out.endpoint
  }
  return out
}

export interface DialogAddAccountProps {
  initialKind?: BrokerKind
  onSaved: () => void
  onCancel: () => void
}

export function DialogAddAccount(props: DialogAddAccountProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()

  // Robinhood authentication is interactive and owned by RHX. Keep it out of
  // this generic API-key form; all Robinhood entry points open its manager.
  const allSpecs = BrokerRegistry.specs().filter((spec) => spec.kind !== "robinhood")
  const [activeKind, setActiveKind] = createSignal<BrokerKind>(
    props.initialKind && props.initialKind !== "robinhood" ? props.initialKind : allSpecs[0]?.kind ?? "alpaca",
  )
  const activeSpec = () => BrokerRegistry.getSpec(activeKind())

  const [fields, setFields] = createSignal<Fields>(initialFields(activeSpec()))
  const [busy, setBusy] = createSignal(false)
  // Tracks whether the user has manually edited the endpoint. While untouched,
  // toggling mode auto-syncs the endpoint to the mode's canonical URL. Once
  // edited, we leave the user's value alone.
  const [endpointTouched, setEndpointTouched] = createSignal(false)

  const switchBroker = (kind: BrokerKind) => {
    setActiveKind(kind)
    setFields(initialFields(BrokerRegistry.getSpec(kind)))
    setEndpointTouched(false)
  }

  const setField = (name: string, value: string) => {
    setFields((prev) => {
      const next = { ...prev, [name]: value }
      // When the user picks paper/live/testnet or a connection app, replace the
      // endpoint with the canonical URL — unless they've already typed a custom one.
      if (name === "mode" || name === "connection") {
        const spec = activeSpec()
        if (spec.endpointForMode && !endpointTouched()) {
          const mode = (name === "mode" ? value : next.mode) as BrokerMode
          const connection = (name === "connection" ? value : next.connection) as BrokerConnection
          next.endpoint = spec.endpointForMode(mode, { connection })
        }
      }
      if (name === "endpoint") {
        setEndpointTouched(true)
      }
      return next
    })
  }

  const cancel = () => {
    props.onCancel()
    dialog.clear()
  }

  // Cap scrollable area at ~45% of terminal height so even on small windows
  // the fixed footer (Save / cancel buttons) stays in view.
  const scrollMaxHeight = () => Math.max(6, Math.floor(dimensions().height * 0.45))

  let scrollRef: any
  const inputRefs = new Set<any>()
  const isTextInputFocused = () => {
    const focused = renderer.currentFocusedRenderable
    return !!focused && inputRefs.has(focused)
  }

  useKeyboard((evt) => {
    if (!scrollRef) return
    if (isTextInputFocused()) return
    let handled = true
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      scrollRef.scrollBy?.(-1)
    } else if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      scrollRef.scrollBy?.(1)
    } else if (evt.name === "pageup") {
      scrollRef.scrollBy?.(-10)
    } else if (evt.name === "pagedown") {
      scrollRef.scrollBy?.(10)
    } else {
      handled = false
    }
    if (handled) {
      evt.preventDefault()
      evt.stopPropagation()
    }
  })

  const save = async () => {
    if (busy()) return
    const spec = activeSpec()
    const f = fields()
    const label = (f.label ?? "").trim()
    const keyId = (f.keyId ?? "").trim()
    const secretField = spec.credentialFields.find((c) => c.name === "secret")
    const hasSecretField = Boolean(secretField)
    const requiresSecret = secretField ? secretField.required !== false : false
    const secret = (f.secret ?? "").trim()
    const endpoint = (f.endpoint ?? spec.defaultEndpoint).trim() || spec.defaultEndpoint

    if (!label) {
      toast.show({ message: "Label is required", variant: "warning", duration: 3000 })
      return
    }
    if (!keyId) {
      toast.show({ message: "Account / Key ID is required", variant: "warning", duration: 3000 })
      return
    }
    if (requiresSecret && !secret) {
      toast.show({ message: "Secret is required", variant: "warning", duration: 3000 })
      return
    }

    setBusy(true)
    try {
      const providerID = BrokerRegistry.generateProviderID(spec.kind)
      const metadata: Record<string, string> = {
        keyId,
        kind: spec.providerPrefix,
        label,
      }
      if (spec.credentialFields.some((c) => c.name === "endpoint")) {
        metadata.endpoint = endpoint
      }
      if (spec.credentialFields.some((c) => c.name === "mode")) {
        const modeField = spec.credentialFields.find((c) => c.name === "mode")
        metadata.mode = (f.mode ?? modeField?.default ?? "paper").trim() || "paper"
      }
      if (spec.credentialFields.some((c) => c.name === "connection")) {
        const connectionField = spec.credentialFields.find((c) => c.name === "connection")
        metadata.connection = (f.connection ?? connectionField?.default ?? "gateway").trim() || "gateway"
      }
      const result = await sdk.client.auth.set({
        providerID,
        // Brokerages without a required API secret still need an `api` entry in
        // the auth store so listAccounts can find them. If an optional secret
        // field is filled (for example IBKR Client ID), keep it locally too.
        auth: { type: "api", key: hasSecretField ? secret : "", metadata },
      })
      if ((result as any)?.error) {
        throw new Error((result as any).error?.message ?? "auth.set returned an error")
      }
      const modeSuffix = metadata.mode ? ` (${metadata.mode})` : ""
      toast.show({
        message: `✓ ${spec.displayName}${modeSuffix} account "${label}" saved`,
        variant: "info",
        duration: 5000,
      })
      props.onSaved()
      dialog.clear()
    } catch (e: any) {
      toast.show({ message: `Failed to save: ${e?.message ?? "unknown error"}`, variant: "error", duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const Label = (p: { text: string }) => <text fg={theme.textMuted}>{p.text}</text>
  const InputBox = (p: { value: string; onInput: (v: string) => void }) => (
    <box
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
    >
      <input
        ref={(r: any) => inputRefs.add(r)}
        value={p.value}
        onInput={(v: string) => p.onInput(v)}
        onMouseDown={(r: MouseEvent) => r.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
      />
    </box>
  )

  const tabOptions = (): SegmentedOption<BrokerKind>[] =>
    allSpecs.map((s) => ({ value: s.kind, label: s.displayName }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      {/* Fixed header */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Add brokerage account
        </text>
        <text fg={theme.textMuted} onMouseUp={cancel}>
          esc
        </text>
      </box>

      {/* Fixed brokerage tabs */}
      <box paddingTop={1}>
        <text fg={theme.textMuted}>Brokerage</text>
      </box>
      <SegmentedControl options={tabOptions()} value={activeKind()} onChange={switchBroker} />

      {/* Scrollable form body — credential fields plus docs link */}
      <scrollbox
        ref={(r: any) => (scrollRef = r)}
        maxHeight={scrollMaxHeight()}
        scrollbarOptions={{ visible: true }}
      >
        <box flexDirection="column" gap={1}>
          <box paddingTop={1} flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>Get keys at</text>
            <Link href={activeSpec().docsUrl} fg={theme.primary}>
              {shortHost(activeSpec().docsUrl)}
            </Link>
          </box>

          <For each={activeSpec().credentialFields}>
            {(field) => (
              <>
                <box paddingTop={1}>
                  <Label text={field.label + (field.secret ? " (secret)" : "")} />
                </box>
                {field.choices && field.choices.length > 0 ? (
                  <SegmentedControl
                    options={field.choices.map((c) => ({ value: c, label: c }))}
                    value={fields()[field.name] || field.default || field.choices[0]}
                    onChange={(v) => setField(field.name, v)}
                  />
                ) : (
                  <InputBox value={fields()[field.name] ?? ""} onInput={(v) => setField(field.name, v)} />
                )}
              </>
            )}
          </For>

          <box
            paddingTop={1}
            paddingLeft={2}
            paddingRight={2}
            paddingBottom={1}
            border={["left"]}
            borderColor={theme.info}
            flexDirection="column"
            gap={0}
          >
            <text fg={theme.info} attributes={TextAttributes.BOLD}>
              Local-only
            </text>
            <text fg={theme.textMuted}>
              Keys are saved at ~/.local/share/finny/auth.json (0600 perms). Finny servers never see them.
            </text>
          </box>
        </box>
      </scrollbox>

      {/* Fixed footer — Save button is always visible regardless of scroll. */}
      <box paddingTop={1} flexDirection="row" gap={2}>
        <box
          paddingLeft={2}
          paddingRight={2}
          backgroundColor={busy() ? theme.borderSubtle : theme.primary}
          onMouseUp={save}
        >
          <text fg={theme.background} attributes={TextAttributes.BOLD}>
            {busy() ? "Saving…" : `→ Save ${activeSpec().displayName} account`}
          </text>
        </box>
        <box paddingLeft={2} paddingRight={2} onMouseUp={cancel}>
          <text fg={theme.textMuted}>cancel</text>
        </box>
        <box flexGrow={1} />
        <text fg={theme.textMuted}>↑↓ scroll</text>
      </box>
    </box>
  )
}

DialogAddAccount.show = (dialog: DialogContext, opts: { initialKind?: BrokerKind } = {}) => {
  return new Promise<boolean>((resolve) => {
    dialog.replace(
      () => (
        <DialogAddAccount
          initialKind={opts.initialKind}
          onSaved={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
}
