import { expect, test } from "bun:test"
import { ProcessSignal } from "@opencode-ai/core/process-signal"
import { foregroundCommandExitError, rhxLoginEnvironment, withForegroundSignalGuard } from "./foreground-command"

test("RHX login keeps required runtime and keyring variables without host secrets", () => {
  expect(
    rhxLoginEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/finny",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTPS_PROXY: "http://proxy.example.test",
      SSL_CERT_DIR: "/etc/ssl/certs",
      RH_USERNAME: "must-not-leak",
      RH_PASSWORD: "must-not-leak",
      RH_MFA_CODE: "must-not-leak",
      RH_CRYPTO_API_KEY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
    }),
  ).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/finny",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    HTTPS_PROXY: "http://proxy.example.test",
    SSL_CERT_DIR: "/etc/ssl/certs",
  })
})

test("foreground command treats an observed SIGINT as cancellation even when the child exits zero", () => {
  const error = foregroundCommandExitError(0, null, true)
  expect(error?.cancelled).toBe(true)
  expect(error?.message).toBe("Interactive command cancelled")
})

test("foreground signal guard prevents gated parent shutdown on SIGINT", async () => {
  let shutdowns = 0
  const shutdown = (signal: NodeJS.Signals) => {
    if (!ProcessSignal.isOwned(signal)) shutdowns += 1
  }
  process.on("SIGINT", shutdown)

  try {
    await withForegroundSignalGuard("SIGINT", async (interrupted) => {
      expect(ProcessSignal.isOwned("SIGINT")).toBe(true)
      process.emit("SIGINT", "SIGINT")
      expect(interrupted()).toBe(true)
      expect(shutdowns).toBe(0)
    })
    expect(ProcessSignal.isOwned("SIGINT")).toBe(false)
  } finally {
    process.off("SIGINT", shutdown)
  }
})
