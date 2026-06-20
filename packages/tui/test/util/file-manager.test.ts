import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  chooseDirectoryLabel,
  directoryPickerCommands,
  fileManagerName,
  finnyHomeForSelectedDirectory,
} from "../../src/util/file-manager"

describe("util.file-manager", () => {
  test("labels native file managers by platform", () => {
    expect(fileManagerName({ platform: "darwin" })).toBe("Finder")
    expect(fileManagerName({ platform: "win32" })).toBe("File Explorer")
    expect(fileManagerName({ platform: "linux" })).toBe("file manager")

    expect(chooseDirectoryLabel({ platform: "darwin" })).toBe("Choose with Finder...")
    expect(chooseDirectoryLabel({ platform: "win32" })).toBe("Choose with File Explorer...")
  })

  test("builds platform picker commands without launching them", () => {
    expect(directoryPickerCommands({ platform: "darwin", initialPath: "/Users/me/Finny" })[0]).toMatchObject({
      command: "osascript",
    })
    expect(directoryPickerCommands({ platform: "win32", initialPath: String.raw`C:\Users\me\Finny` })[0]).toMatchObject({
      command: "powershell.exe",
    })
    expect(directoryPickerCommands({ platform: "linux", initialPath: "/home/me/finny" }).map((item) => item.command)).toEqual(
      ["zenity", "kdialog"],
    )
  })

  test("treats a selected parent as the place where the finny folder should live", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-picker-"))
    const desktop = path.join(root, "Desktop")
    await fs.mkdir(desktop)

    expect(await finnyHomeForSelectedDirectory({ path: desktop })).toBe(path.join(desktop, "finny"))
  })

  test("keeps an explicit finny folder selection as the home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-picker-"))
    const finny = path.join(root, "finny")
    await fs.mkdir(finny)

    expect(await finnyHomeForSelectedDirectory({ path: finny })).toBe(finny)
  })

  test("keeps existing artifact roots as the home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-picker-"))
    const custom = path.join(root, "custom-home")
    await fs.mkdir(path.join(custom, "algorithms"), { recursive: true })

    expect(await finnyHomeForSelectedDirectory({ path: custom })).toBe(custom)
  })
})
