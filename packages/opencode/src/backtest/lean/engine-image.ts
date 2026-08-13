import fs from "node:fs/promises"
import path from "node:path"
import { Process } from "@/util/process"
import { LEAN_PINNED_COMMIT, LEAN_PINNED_IMAGE_DIGEST } from "./contracts"

const ENGINE_IMAGE = "ghcr.io/finny-ai/lean-engine"
const LEAN_UPSTREAM = "https://github.com/QuantConnect/Lean.git"
const DOCKER_BASE_ENV = { PATH: process.env.PATH ?? "" }

export type LeanEngineImageStatus = {
  pinnedCommit: string
  pinnedDigest: string
  daemonUp: boolean
  imagePresent: boolean
  imageRef: string
}

export type LeanEngineActionResult = LeanEngineImageStatus & {
  ok: boolean
  message: string
  localDigest?: string
  requiresRestart?: boolean
  newCommit?: string
}

async function dockerRun(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await Process.run(["docker", ...args], {
    nothrow: true,
    timeout: timeoutMs,
    env: DOCKER_BASE_ENV,
    inheritEnv: false,
  })
  return {
    code: result.code,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

async function dockerAvailable(): Promise<boolean> {
  const probe = await dockerRun(["version", "--format", "{{.Server.Version}}"], 15_000)
  return probe.code === 0
}

/** True when the local image's RepoDigests contain the exact pinned digest. */
async function pinnedImagePresent(): Promise<boolean> {
  const inspect = await dockerRun(
    ["image", "inspect", LEAN_PINNED_IMAGE_DIGEST, "--format", "{{json .RepoDigests}}"],
    15_000,
  )
  if (inspect.code !== 0) return false
  try {
    const digests = JSON.parse(inspect.stdout) as string[]
    return Array.isArray(digests) && digests.some((entry) => entry.includes(LEAN_PINNED_IMAGE_DIGEST))
  } catch {
    return false
  }
}

export async function leanEngineImageStatus(): Promise<LeanEngineImageStatus> {
  const daemonUp = await dockerAvailable()
  return {
    pinnedCommit: LEAN_PINNED_COMMIT,
    pinnedDigest: LEAN_PINNED_IMAGE_DIGEST,
    daemonUp,
    imagePresent: daemonUp ? await pinnedImagePresent() : false,
    imageRef: ENGINE_IMAGE,
  }
}

/**
 * Ordered pull refs for the pinned engine image. The digest comes first so a
 * pull never depends on a tag existing; tag fallbacks are only used when the
 * digest is not directly reachable. Every attempt is verified against the
 * pinned digest before it is accepted.
 */
export function pinnedImagePullRefs(commit: string, digest: string): Array<{ label: string; ref: string }> {
  const refs: Array<{ label: string; ref: string }> = [
    { label: `pinned digest ${digest.slice(7, 19)}`, ref: `${ENGINE_IMAGE}@${digest}` },
    { label: "latest tag", ref: `${ENGINE_IMAGE}:latest` },
    { label: `commit tag ${commit.slice(0, 12)}`, ref: `${ENGINE_IMAGE}:${commit}` },
    { label: "dev tag", ref: `${ENGINE_IMAGE}:dev` },
  ]
  return refs.filter((entry, index) => refs.findIndex((other) => other.ref === entry.ref) === index)
}

/**
 * Pull the certified engine image and verify it matches the pinned digest.
 * Pulls by digest first (no tag required); falls back to latest/commit/dev
 * tags, each verified against the pin before being accepted.
 */
export async function pullPinnedLeanImage(): Promise<LeanEngineActionResult> {
  const base = await leanEngineImageStatus()
  if (!base.daemonUp) {
    return { ...base, ok: false, message: "Docker daemon is not running (start Colima or Docker Desktop first)." }
  }
  if (base.imagePresent) {
    return { ...base, ok: true, message: "Pinned engine image is already present locally." }
  }
  let lastError = "no registry reference resolved to the pinned digest"
  for (const { label, ref } of pinnedImagePullRefs(LEAN_PINNED_COMMIT, LEAN_PINNED_IMAGE_DIGEST)) {
    const pull = await dockerRun(["pull", ref], 30 * 60_000)
    if (pull.code === 0 && (await pinnedImagePresent())) {
      // Retag to the commit tag for tidiness; digest-based runs do not need it.
      await dockerRun(["tag", ref, `${ENGINE_IMAGE}:${LEAN_PINNED_COMMIT}`], 15_000)
      return {
        ...base,
        ok: true,
        message: `Pinned engine image is ready (pulled via ${label}; digest verified).`,
      }
    }
    lastError = pull.stderr.slice(0, 300) || pull.stdout.slice(0, 300) || lastError
  }
  return {
    ...base,
    ok: false,
    message: `Could not pull the pinned engine image: ${lastError}. If the registry is private, log in with docker login ghcr.io first.`,
  }
}

/**
 * Build the engine image from the bundled Dockerfile template at the pinned
 * commit. A locally built image only becomes runnable through the release
 * pipeline (publish + digest update); this is for dev machines and release
 * operators.
 */
export async function buildLeanEngineImage(): Promise<LeanEngineActionResult> {
  const base = await leanEngineImageStatus()
  if (!base.daemonUp) {
    return { ...base, ok: false, message: "Docker daemon is not running (start Colima or Docker Desktop first)." }
  }
  try {
    const engineDir = path.resolve(import.meta.dir, "../../../lean-engine")
    const dockerfile = path.join(engineDir, "Dockerfile")
    try {
      await fs.access(dockerfile)
    } catch {
      return {
        ...base,
        ok: false,
        message: `Engine Dockerfile template not found at ${dockerfile}; this build action requires the repo checkout.`,
      }
    }
    const tag = `${ENGINE_IMAGE}:${LEAN_PINNED_COMMIT}`
    const build = await dockerRun(
      ["build", "-f", dockerfile, "-t", tag, engineDir],
      60 * 60_000,
    )
    if (build.code !== 0) {
      return {
        ...base,
        ok: false,
        message: `Image build failed: ${build.stderr.slice(0, 800) || build.stdout.slice(0, 800)}`,
      }
    }
    const inspect = await dockerRun(
      ["image", "inspect", tag, "--format", "{{index .RepoDigests 0}}"],
      15_000,
    )
    const localDigest = inspect.code === 0 ? inspect.stdout.split("@").pop() : undefined
    return {
      ...base,
      ok: true,
      localDigest,
      message:
        `Built ${tag}. ` +
        (localDigest && localDigest !== LEAN_PINNED_IMAGE_DIGEST
          ? "The local digest differs from the certified multi-arch digest — publish it through the release pipeline and update LEAN_PINNED_IMAGE_DIGEST for it to run."
          : "Local digest matches the pinned digest."),
    }
  } catch (error) {
    return { ...base, ok: false, message: `Image build failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Check upstream QuantConnect LEAN master for a newer commit than the pinned
 * one. When newer and the repo checkout is writable (dev mode), this performs
 * the full engine upgrade: bump LEAN_COMMIT, rebuild the image, update the
 * pinned digest, and best-effort push to the registry.
 */
export async function updateLeanEngineToLatest(): Promise<LeanEngineActionResult> {
  const base = await leanEngineImageStatus()
  const git = await Process.run(["git", "ls-remote", LEAN_UPSTREAM, "refs/heads/master"], {
    nothrow: true,
    timeout: 60_000,
    env: DOCKER_BASE_ENV,
    inheritEnv: false,
  })
  if (git.code !== 0) {
    return {
      ...base,
      ok: false,
      message: "Could not reach QuantConnect Lean upstream to check for updates.",
    }
  }
  const latest = git.stdout.toString().trim().split(/\s+/)[0]
  return await applyUpgrade(base, latest)
}

/**
 * Pure update of the pinned engine constants in contracts.ts and the
 * Dockerfile. Returns null when the expected constant shapes are not found.
 */
export function nextPinnedConstants(
  contracts: string,
  dockerfile: string,
  commit: string,
  digest: string,
): { contracts: string; dockerfile: string } | null {
  const nextContracts = contracts
    .replace(/LEAN_PINNED_COMMIT = "[0-9a-f]{40}"/, `LEAN_PINNED_COMMIT = "${commit}"`)
    .replace(
      /LEAN_PINNED_IMAGE_DIGEST = "sha256:[0-9a-f]{64}"/,
      `LEAN_PINNED_IMAGE_DIGEST = "${digest}"`,
    )
  const nextDockerfile = dockerfile.replace(/ARG LEAN_COMMIT=[0-9a-f]{40}/, `ARG LEAN_COMMIT=${commit}`)
  if (nextContracts === contracts || nextDockerfile === dockerfile) return null
  return { contracts: nextContracts, dockerfile: nextDockerfile }
}

async function applyUpgrade(base: LeanEngineImageStatus, latestCommit: string): Promise<LeanEngineActionResult> {
  if (!latestCommit || !/^[0-9a-f]{40}$/.test(latestCommit)) {
    return { ...base, ok: false, message: "Upstream returned an unexpected response." }
  }
  if (latestCommit === LEAN_PINNED_COMMIT) {
    return { ...base, ok: true, message: `Engine is already at the latest upstream commit (${latestCommit.slice(0, 12)}).` }
  }
  const contractsPath = path.resolve(import.meta.dir, "./contracts.ts")
  const engineDir = path.resolve(import.meta.dir, "../../../lean-engine")
  const dockerfilePath = path.join(engineDir, "Dockerfile")
  try {
    await Promise.all([fs.access(contractsPath), fs.access(dockerfilePath)])
  } catch {
    return {
      ...base,
      ok: false,
      newCommit: latestCommit,
      message:
        `Upstream has a newer engine commit (${latestCommit.slice(0, 12)}). Auto-upgrade needs the repo checkout ` +
        "(contracts.ts + lean-engine/Dockerfile). Update the pinned constants and publish a new certified image to use it.",
    }
  }
  if (!base.daemonUp) {
    return {
      ...base,
      ok: false,
      newCommit: latestCommit,
      message: `Upstream has a newer engine commit (${latestCommit.slice(0, 12)}), but the Docker daemon is not running.`,
    }
  }

  let nextContracts: string
  try {
    const contracts = await fs.readFile(contractsPath, "utf8")
    const dockerfile = await fs.readFile(dockerfilePath, "utf8")
    const patched = nextPinnedConstants(contracts, dockerfile, latestCommit, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
    if (!patched) {
      return { ...base, ok: false, newCommit: latestCommit, message: "Could not locate the pinned constants to update." }
    }
    nextContracts = patched.contracts
    await Promise.all([fs.writeFile(contractsPath, patched.contracts), fs.writeFile(dockerfilePath, patched.dockerfile)])
  } catch (error) {
    return {
      ...base,
      ok: false,
      newCommit: latestCommit,
      message: `Could not update pinned constants: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const tag = `${ENGINE_IMAGE}:${latestCommit}`
  const build = await dockerRun(["build", "-f", dockerfilePath, "-t", tag, engineDir], 60 * 60_000)
  if (build.code !== 0) {
    return {
      ...base,
      ok: false,
      newCommit: latestCommit,
      message: `Build of ${latestCommit.slice(0, 12)} failed: ${build.stderr.slice(0, 500)}. Constants were updated on disk.`,
    }
  }
  const inspect = await dockerRun(
    ["image", "inspect", tag, "--format", "{{index .RepoDigests 0}}"],
    15_000,
  )
  const localDigest = inspect.code === 0 ? inspect.stdout.split("@").pop() : undefined
  if (localDigest && /^sha256:[0-9a-f]{64}$/.test(localDigest)) {
    const updated = nextContracts.replace(
      /LEAN_PINNED_IMAGE_DIGEST = "sha256:[0-9a-f]{64}"/,
      `LEAN_PINNED_IMAGE_DIGEST = "${localDigest}"`,
    )
    await fs.writeFile(contractsPath, updated)
  }

  const push = await dockerRun(["push", tag], 30 * 60_000)
  let pushNote = ""
  if (push.code !== 0) {
    pushNote =
      " Image was NOT pushed (registry auth required) — other machines will fail closed until it is published."
  } else {
    const latestTag = await dockerRun(["tag", tag, `${ENGINE_IMAGE}:latest`], 15_000)
    if (latestTag.code === 0) await dockerRun(["push", `${ENGINE_IMAGE}:latest`], 30 * 60_000)
    pushNote = " Image pushed to the registry."
  }
  return {
    ...base,
    ok: true,
    newCommit: latestCommit,
    localDigest,
    requiresRestart: true,
    message:
      `Engine upgraded to ${latestCommit.slice(0, 12)}. Restart Finny to load the new pinned digest.` +
      pushNote,
  }
}
