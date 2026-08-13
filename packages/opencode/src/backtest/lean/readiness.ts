import { Process } from "../../util/process"
import { LEAN_PINNED_IMAGE_DIGEST } from "./contracts"
import type { LeanReadyStateV1 } from "./types"

/**
 * Live Docker/image readiness probe. The image must exist locally with the
 * exact pinned digest on a supported architecture; anything else is not ready.
 */
export async function probeLeanDockerReadiness(input?: {
  pinnedDigest?: string
}): Promise<LeanReadyStateV1> {
  const reasons: string[] = []
  const docker = await Process.run(["docker", "version", "--format", "{{.Server.Version}}"], {
    nothrow: true,
    timeout: 15_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
    },
    inheritEnv: false,
  })
  if (docker.code !== 0) {
    return {
      dockerAvailable: false,
      platformSupported: process.platform !== "win32",
      imageVerified: false,
      adapterCertificate: false,
      ready: false,
      reasons: [`docker daemon is unavailable: ${docker.stderr.toString().trim() || docker.stdout.toString().trim()}`],
    }
  }

  const pinned = input?.pinnedDigest ?? LEAN_PINNED_IMAGE_DIGEST
  const inspect = await Process.run(
    ["docker", "image", "inspect", pinned, "--format", "{{json .RepoDigests}}"],
    {
      nothrow: true,
      timeout: 15_000,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" },
      inheritEnv: false,
    },
  )
  let imageVerified = false
  if (inspect.code !== 0) {
    reasons.push(`pinned image ${pinned} is not present locally`)
  } else {
    try {
      const digests = JSON.parse(inspect.stdout.toString().trim()) as string[]
      imageVerified = digests.some((digest) => digest.includes(pinned.replace("sha256:", "@sha256:")))
      if (!imageVerified) reasons.push(`local image digests do not include the pinned digest ${pinned}`)
    } catch {
      reasons.push("docker image inspect returned unparseable digests")
    }
  }

  const platformSupported = process.platform === "darwin" || process.platform === "linux"
  if (!platformSupported) reasons.push(`platform ${process.platform} is unsupported for v1`)

  return {
    dockerAvailable: true,
    platformSupported,
    imageVerified,
    adapterCertificate: false,
    ready: imageVerified && platformSupported,
    reasons,
  }
}
