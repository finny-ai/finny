import type { JSX } from "solid-js"
import { SidebarNav } from "./sidebar-nav"

export function Shell(props: { children: JSX.Element }) {
  return (
    <box flexDirection="row" flexGrow={1}>
      <SidebarNav />
      <box flexGrow={1} flexDirection="column" minWidth={0}>
        {props.children}
      </box>
    </box>
  )
}
