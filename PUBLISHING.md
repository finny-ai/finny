# Publishing Finny to npm

This guide explains how to publish the finny CLI so users can install it with:

```bash
npm install -g finny
finny
```

## Prerequisites

1. **npm account** - Create one at https://www.npmjs.com/signup
2. **npm token** - Generate at https://www.npmjs.com/settings/YOUR_USERNAME/tokens
   - Select "Automation" token type for CI/CD

## Setup (One-time)

### 1. Add npm token to GitHub

1. Go to your repo → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `NPM_TOKEN`
4. Value: Your npm automation token

### 2. Update package info

Edit `packages/finny/npm/package.json`:
- Replace `YOUR_USERNAME` with your GitHub username
- Update description, keywords, etc.

## Publishing

### Option 1: Tag-based (Recommended)

Create and push a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This triggers the GitHub Action which:
1. Builds binaries for all platforms
2. Publishes to npm

### Option 2: Manual trigger

1. Go to Actions → "Publish to npm"
2. Click "Run workflow"
3. Enter version (e.g., `1.0.0`)
4. Click "Run workflow"

### Option 3: Local publish (testing)

```bash
# Build all platforms
cd packages/finny
FINNY_VERSION=1.0.0 FINNY_CHANNEL=latest bun run build

# Publish platform packages
for pkg in dist/finny-*/; do
  cd "$pkg" && npm publish --access public && cd ../..
done

# Publish main package
cd npm && npm publish --access public
```

## Package Structure

When published, users get:

```
finny                    # Main package (small, ~10KB)
├── bin/finny            # Launcher script
├── scripts/postinstall.js
└── optionalDependencies:
    ├── finny-darwin-arm64   # Mac ARM (M1/M2)
    ├── finny-darwin-x64     # Mac Intel
    ├── finny-linux-arm64    # Linux ARM
    ├── finny-linux-x64      # Linux x64
    └── finny-windows-x64    # Windows
```

npm automatically installs only the matching platform package.

## Versioning

- Use semantic versioning: `MAJOR.MINOR.PATCH`
- Breaking changes → bump MAJOR
- New features → bump MINOR
- Bug fixes → bump PATCH

## Troubleshooting

### "Package name already taken"

The package name `finny` is currently available. If taken by the time you publish, update the name in:
- `packages/finny/npm/package.json`
- All `optionalDependencies` entries
- The GitHub workflow

### "Permission denied" on install

Users might need to fix npm permissions:
```bash
# Option 1: Use nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Option 2: Change npm prefix
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

### Binary not found after install

The platform-specific package might not have been installed:
```bash
npm install finny-$(node -p "process.platform + '-' + process.arch")
```
