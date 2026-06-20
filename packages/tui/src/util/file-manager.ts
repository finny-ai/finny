import fs from "node:fs/promises"
import path from "node:path"

type CommandSpec = {
  command: string
  args: string[]
}

type CommandResult = {
  code: number
  stdout: string
  stderr: string
}

type FileManagerPlatformRequest = {
  platform?: string
}

type DirectoryPickerCommandRequest = FileManagerPlatformRequest & {
  initialPath: string
}

type DirectoryPickerRequest = FileManagerPlatformRequest & {
  currentPath: string
}

type PathRequest = {
  path: string
}

type QuotedStringRequest = {
  value: string
}

type PickerResult = {
  selectedPath?: string
  error?: Error
  cancelled?: boolean
}

const FINNY_HOME_DIR = "finny"
const FINNY_ARTIFACT_DIRS = ["algos", "algorithms", "python-env", "session-workspaces"]

export function fileManagerName(request: FileManagerPlatformRequest = {}): string {
  const platform = request.platform ?? process.platform
  if (platform === "darwin") return "Finder"
  if (platform === "win32") return "File Explorer"
  return "file manager"
}

export function chooseDirectoryLabel(request: FileManagerPlatformRequest = {}): string {
  const platform = request.platform ?? process.platform
  if (platform === "darwin") return "Choose with Finder..."
  if (platform === "win32") return "Choose with File Explorer..."
  return "Choose folder..."
}

function appleScriptString(request: QuotedStringRequest): string {
  const value = request.value
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function powershellString(request: QuotedStringRequest): string {
  const value = request.value
  return `'${value.replace(/'/g, "''")}'`
}

export function directoryPickerCommands(request: DirectoryPickerCommandRequest): CommandSpec[] {
  const platform = request.platform ?? process.platform
  const initialPath = request.initialPath
  if (platform === "darwin") {
    const script = [
      `set defaultFolder to POSIX file ${appleScriptString({ value: initialPath })}`,
      `set selectedFolder to choose folder with prompt "Choose Finny Home" default location defaultFolder`,
      "POSIX path of selectedFolder",
    ].join("\n")
    return [{ command: "osascript", args: ["-e", script] }]
  }

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Choose Finny Home'",
      `$dialog.SelectedPath = ${powershellString({ value: initialPath })}`,
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    ].join("; ")
    return [
      { command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] },
      { command: "pwsh.exe", args: ["-NoProfile", "-Command", script] },
    ]
  }

  return [
    {
      command: "zenity",
      args: ["--file-selection", "--directory", "--title=Choose Finny Home", `--filename=${initialPath}${path.sep}`],
    },
    { command: "kdialog", args: ["--getexistingdirectory", initialPath, "--title", "Choose Finny Home"] },
  ]
}

async function nearestExistingDirectory(request: PathRequest): Promise<string> {
  let current = path.resolve(request.path)
  while (true) {
    try {
      const stat = await fs.stat(current)
      if (stat.isDirectory()) return current
    } catch {}

    const parent = path.dirname(current)
    if (parent === current) return process.cwd()
    current = parent
  }
}

async function pathHasDirectory(request: PathRequest): Promise<boolean> {
  try {
    return (await fs.stat(request.path)).isDirectory()
  } catch {
    return false
  }
}

export async function finnyHomeForSelectedDirectory(request: PathRequest): Promise<string> {
  const selected = path.resolve(request.path)
  if (path.basename(selected).toLowerCase() === FINNY_HOME_DIR) return selected

  for (const artifact of FINNY_ARTIFACT_DIRS) {
    if (await pathHasDirectory({ path: path.join(selected, artifact) })) return selected
  }

  return path.join(selected, FINNY_HOME_DIR)
}

async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const proc = Bun.spawn([spec.command, ...spec.args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

function isPickerCancel(result: CommandResult): boolean {
  if (result.code === 0) return false
  const combined = `${result.stdout}\n${result.stderr}`
  return /cancel/i.test(combined) || (result.code === 1 && result.stdout.trim() === "" && result.stderr.trim() === "")
}

function pickerResultFromCommand(result: CommandResult): PickerResult {
  const selectedPath = result.stdout.trim()
  if (result.code === 0) {
    return selectedPath ? { selectedPath } : { cancelled: true }
  }
  if (isPickerCancel(result)) return { cancelled: true }
  return { error: new Error(result.stderr.trim() || `Directory picker exited with ${result.code}`) }
}

function pickerResultFromError(error: unknown): PickerResult {
  return { error: error instanceof Error ? error : new Error(String(error)) }
}

async function runPickerCommand(spec: CommandSpec): Promise<PickerResult> {
  try {
    return pickerResultFromCommand(await runCommand(spec))
  } catch (err) {
    return pickerResultFromError(err)
  }
}

function isTerminalPickerResult(result: PickerResult): boolean {
  return result.selectedPath !== undefined || result.cancelled === true
}

async function runPickerCommands(commands: CommandSpec[]): Promise<PickerResult> {
  let result: PickerResult = { error: new Error("No directory picker is available") }
  for (const spec of commands) {
    result = await runPickerCommand(spec)
    if (isTerminalPickerResult(result)) return result
  }
  return result
}

export async function chooseDirectoryWithFileManager(request: DirectoryPickerRequest): Promise<string | undefined> {
  const initialPath = await nearestExistingDirectory({ path: request.currentPath })
  const result = await runPickerCommands(
    directoryPickerCommands({ platform: request.platform, initialPath }),
  )

  if (result.selectedPath) return finnyHomeForSelectedDirectory({ path: result.selectedPath })
  if (result.cancelled) return undefined

  throw result.error ?? new Error("No directory picker is available")
}
