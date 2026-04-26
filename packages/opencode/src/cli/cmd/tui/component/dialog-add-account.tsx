import { createSignal, For } from "solid-js"
import { TextAttributes, MouseEvent } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useDialog, type DialogContext } from "../ui/dialog"
import { BrokerRegistry, type BrokerKind, type BrokerSpec } from "@/live/brokers"
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

function emptyFields(spec: BrokerSpec): Fields {
  const out: Fields = {}
  for (const f of spec.credentialFields) out[f.name] = f.default ?? ""
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

  const allSpecs = BrokerRegistry.specs()
  const [activeKind, setActiveKind] = createSignal<BrokerKind>(
    props.initialKind ?? allSpecs[0]?.kind ?? "alpaca",
  )
  const activeSpec = () => BrokerRegistry.getSpec(activeKind())

  const [fields, setFields] = createSignal<Fields>(emptyFields(activeSpec()))
  const [busy, setBusy] = createSignal(false)

  const switchBroker = (kind: BrokerKind) => {
    setActiveKind(kind)
    setFields(emptyFields(BrokerRegistry.getSpec(kind)))
  }

  const setField = (name: string, value: string) => {
    setFields({ ...fields(), [name]: value })
  }

  const cancel = () => {
    props.onCancel()
    dialog.clear()
  }

  const save = async () => {
    if (busy()) return
    const spec = activeSpec()
    const f = fields()
    const label = (f.label ?? "").trim()
    const keyId = (f.keyId ?? "").trim()
    const secret = (f.secret ?? "").trim()
    const endpoint = (f.endpoint ?? spec.defaultEndpoint).trim() || spec.defaultEndpoint

    if (!label) {
      toast.show({ message: "Label is required", variant: "warning", duration: 3000 })
      return
    }
    if (!keyId || !secret) {
      toast.show({ message: "Both API key and secret are required", variant: "warning", duration: 3000 })
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
      const result = await sdk.client.auth.set({
        providerID,
        auth: { type: "api", key: secret, metadata },
      })
      if ((result as any)?.error) {
        throw new Error((result as any).error?.message ?? "auth.set returned an error")
      }
      toast.show({
        message: `✓ ${spec.displayName} account "${label}" saved`,
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
  const InputBox = (p: { onInput: (v: string) => void }) => (
    <box
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
    >
      <input
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
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Add paper trading account
        </text>
        <text fg={theme.textMuted} onMouseUp={cancel}>
          esc
        </text>
      </box>

      <box paddingTop={1}>
        <text fg={theme.textMuted}>Brokerage</text>
      </box>
      <SegmentedControl options={tabOptions()} value={activeKind()} onChange={switchBroker} />

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
            <InputBox onInput={(v) => setField(field.name, v)} />
          </>
        )}
      </For>

      <box paddingTop={2} flexDirection="row" gap={2}>
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
      </box>

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
