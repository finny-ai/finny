import { createMemo, createResource } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useLocal } from "../context/local"
import { BrokerRegistry, type BrokerKind } from "@/live/brokers"
import { DialogAddAccount } from "./dialog-add-account"

export function DialogBrokerage() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()

  const [accounts] = createResource(() => BrokerRegistry.listAccounts())

  const options = createMemo(() => {
    const accs = accounts() ?? []
    return BrokerRegistry.specs().map((spec) => {
      const count = accs.filter((a) => a.brokerKind === spec.kind).length
      const isActive = local.brokerage.current() === spec.kind
      return {
        title: spec.displayName,
        value: spec.kind as BrokerKind,
        description: count > 0 ? `${count} account${count === 1 ? "" : "s"}` : "No accounts — pick to add one",
        gutter: isActive ? <text fg={theme.success}>✓</text> : undefined,
        onSelect() {
          local.brokerage.set(spec.kind)
          if (count === 0) {
            // Pivot straight into the add-account dialog pre-filtered to this brokerage.
            DialogAddAccount.show(dialog, { initialKind: spec.kind })
            return
          }
          dialog.clear()
        },
      }
    })
  })

  return <DialogSelect title="Select brokerage" options={options()} />
}
