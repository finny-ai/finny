# Finny CLI Launcher

Node.js wrapper that resolves and launches the platform-native Finny binary.

## Windows Terminal requirement (Windows only)

The interactive TUI requires a modern terminal emulator with VT sequence
support. On Windows the launcher will **auto-relaunch inside Windows Terminal**
when run from the legacy Console Host. If Windows Terminal is not installed,
a helpful error with installation instructions is shown.

Supported terminals:
- **Windows Terminal** (recommended) — `winget install Microsoft.WindowsTerminal`
- **VS Code integrated terminal**

Non-interactive commands (`--version`, `--help`, etc.) bypass this check.
