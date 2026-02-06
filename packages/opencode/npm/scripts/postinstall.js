#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PLATFORMS = {
  "darwin-arm64": "finny-darwin-arm64",
  "darwin-x64": "finny-darwin-x64",
  "linux-arm64": "finny-linux-arm64",
  "linux-x64": "finny-linux-x64",
  "win32-x64": "finny-windows-x64",
};

const platform = `${process.platform}-${process.arch}`;
const packageName = PLATFORMS[platform];

if (!packageName) {
  console.warn(`\n[finny] Warning: Unsupported platform ${platform}`);
  console.warn(`[finny] Supported: ${Object.keys(PLATFORMS).join(", ")}`);
  console.warn(`[finny] The CLI may not work on this platform.\n`);
  process.exit(0);
}

// Check if the platform package was installed
const possiblePaths = [
  path.join(__dirname, "..", "node_modules", packageName),
  path.join(__dirname, "..", "..", packageName),
  path.join(__dirname, "..", "..", "..", packageName),
];

const installed = possiblePaths.some(p => fs.existsSync(p));

if (!installed) {
  console.warn(`\n[finny] Warning: Platform package ${packageName} not found`);
  console.warn(`[finny] This might happen if optional dependencies are disabled`);
  console.warn(`[finny] Try: npm install ${packageName}\n`);
} else {
  // Make binary executable (fix for npm not preserving permissions)
  for (const basePath of possiblePaths) {
    const binaryPath = path.join(basePath, "bin", "finny");
    const binaryPathExe = path.join(basePath, "bin", "finny.exe");

    try {
      if (fs.existsSync(binaryPath)) {
        fs.chmodSync(binaryPath, 0o755);
      }
      if (fs.existsSync(binaryPathExe)) {
        fs.chmodSync(binaryPathExe, 0o755);
      }
    } catch (e) {
      // Ignore permission errors on Windows
    }
  }
}
