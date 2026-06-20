import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

const bus = new EventEmitter<{
  event: [GlobalEvent]
}>()

const emit = bus.emit.bind(bus)
bus.emit = ((eventName: string | symbol, ...args: unknown[]) => {
  const event = args[0] as GlobalEvent | undefined
  if (eventName === "event" && event) {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
  }
  return (emit as (eventName: string | symbol, ...args: unknown[]) => boolean)(eventName, ...args)
}) as typeof bus.emit

export const GlobalBus = bus
