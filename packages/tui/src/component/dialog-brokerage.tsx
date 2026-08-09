import { createMemo, createResource } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "../context/theme"
import { useLocal } from "../context/local"
import { BrokerRegistry, type BrokerKind } from "@/live/brokers"
import { DialogAddAccount } from "./dialog-add-account"
import { DialogRobinhood } from "./dialog-robinhood"
import { useToast } from "../ui/toast"

export function DialogBrokerage() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const local = useLocal()
  const toast = useToast()

  const [accounts] = createResource(() => BrokerRegistry.listAccounts())

  const options = createMemo<DialogSelectOption<BrokerKind>[]>(() => {
    const accs = accounts() ?? []
    return BrokerRegistry.specs().map((spec) => {
      const count = accs.filter((a) => a.brokerKind === spec.kind).length
      const isActive = local.brokerage.current() === spec.kind
      return {
        title: spec.displayName,
        value: spec.kind as BrokerKind,
        description:
          spec.kind === "robinhood"
            ? "Official OAuth · manage connection"
            : count > 0
              ? `${count} account${count === 1 ? "" : "s"}`
              : "No accounts — pick to add one",
        gutter: isActive ? () => <text fg={theme.success}>✓</text> : undefined,
        onSelect() {
          if (spec.kind === "robinhood") {
            void DialogRobinhood.show(dialog)
            return
          }
          void local.brokerage.set(spec.kind).catch((error) => {
            toast.show({
              message: `Could not persist active brokerage: ${error instanceof Error ? error.message : String(error)}`,
              variant: "error",
              duration: 5000,
            })
          })
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
