import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { createServer, type Server } from "node:http"
import { Daemon } from "@/cli/daemon"
import { tmpdir } from "../fixture/fixture"

// Spin up a throwaway HTTP server that answers /global/health like the real
// daemon, so we can exercise probe() and the ensure() reuse path without
// spawning an actual `finny serve`.
async function healthyServer(opts: { password?: string } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/global/health") {
      if (opts.password) {
        const expected = "Basic " + Buffer.from(`finny:${opts.password}`).toString("base64")
        if (req.headers.authorization !== expected) {
          res.writeHead(401).end()
          return
        }
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ healthy: true, version: "test" }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("no address")
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe("cli.daemon", () => {
  let prevHome: string | undefined
  beforeEach(async () => {
    prevHome = process.env.FINNY_HOME
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.FINNY_HOME
    else process.env.FINNY_HOME = prevHome
  })

  test("writeInfo/readInfo round-trips and is 0600", async () => {
    await using tmp = await tmpdir()
    process.env.FINNY_HOME = tmp.path

    const info: Daemon.Info = {
      url: "http://127.0.0.1:4096",
      hostname: "127.0.0.1",
      port: 4096,
      pid: 12345,
      password: "secret",
      startedAt: Date.now(),
      version: "test",
    }
    await Daemon.writeInfo(info)

    const read = await Daemon.readInfo()
    expect(read).toEqual(info)

    if (process.platform !== "win32") {
      const stat = await fs.stat(Daemon.infoPath())
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })

  test("readInfo returns undefined when missing or malformed", async () => {
    await using tmp = await tmpdir()
    process.env.FINNY_HOME = tmp.path
    expect(await Daemon.readInfo()).toBeUndefined()

    await fs.mkdir(tmp.path + "/daemon", { recursive: true })
    await fs.writeFile(Daemon.infoPath(), "{ not json")
    expect(await Daemon.readInfo()).toBeUndefined()
  })

  test("probe is true for a healthy server and false for a dead one", async () => {
    const srv = await healthyServer()
    try {
      expect(await Daemon.probe({ url: srv.url, password: "" })).toBe(true)
    } finally {
      await srv.close()
    }
    // After close, the port is unreachable.
    expect(await Daemon.probe({ url: srv.url, password: "" }, 500)).toBe(false)
  })

  test("probe honors basic auth", async () => {
    const srv = await healthyServer({ password: "pw" })
    try {
      expect(await Daemon.probe({ url: srv.url, password: "pw" })).toBe(true)
      expect(await Daemon.probe({ url: srv.url, password: "wrong" })).toBe(false)
    } finally {
      await srv.close()
    }
  })

  test("ensure reuses an existing healthy daemon (no spawn)", async () => {
    await using tmp = await tmpdir()
    process.env.FINNY_HOME = tmp.path

    const srv = await healthyServer({ password: "pw" })
    try {
      const info: Daemon.Info = {
        url: srv.url,
        hostname: "127.0.0.1",
        port: 0,
        pid: 99999,
        password: "pw",
        startedAt: Date.now(),
        version: "test",
      }
      await Daemon.writeInfo(info)

      const conn = await Daemon.ensure()
      expect(conn.url).toBe(srv.url)
      expect(conn.info.pid).toBe(99999) // reused, not a freshly spawned pid
      expect(conn.headers?.Authorization).toBe("Basic " + Buffer.from("finny:pw").toString("base64"))
    } finally {
      await srv.close()
    }
  })

  test("concurrent ensure() against a healthy daemon both reuse it", async () => {
    await using tmp = await tmpdir()
    process.env.FINNY_HOME = tmp.path

    const srv = await healthyServer()
    try {
      await Daemon.writeInfo({
        url: srv.url,
        hostname: "127.0.0.1",
        port: 0,
        pid: 4242,
        password: "",
        startedAt: Date.now(),
        version: "test",
      })
      const [a, b] = await Promise.all([Daemon.ensure(), Daemon.ensure()])
      expect(a.info.pid).toBe(4242)
      expect(b.info.pid).toBe(4242)
    } finally {
      await srv.close()
    }
  })
})
