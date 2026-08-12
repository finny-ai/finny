# Finny LEAN engine image

This directory defines the Finny-certified QuantConnect LEAN engine image used
by the `lean_python` and `lean_csharp` runtimes. The engine is Apache-2.0;
QuantConnect marks and the QuantConnect CLI/cloud are not used anywhere in the
run path. See `LICENSE`/`NOTICE` handling below.

## Pin policy

`LEAN_COMMIT` is pinned in the Dockerfile to
`c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0`. The TypeScript side pins the same
commit in `src/backtest/lean/contracts.ts` (`LEAN_PINNED_COMMIT`) and the
published image digest (`LEAN_PINNED_IMAGE_DIGEST`). The certified digest is
`sha256:095d848eca682f53fad53bf14f6dafb8006f63249ab86cd350f184262422d652`;
the adapter only refuses to run when the constant is still the
`sha256:000000000000...` placeholder used before a certification lands.

An engine upgrade is a dedicated PR that must update all of:

1. The Dockerfile `LEAN_COMMIT`.
2. `LEAN_PINNED_COMMIT` and the real multi-arch digest in `contracts.ts`.
3. The launcher config generator (`engine-config.ts`) if handler/model names
   changed.
4. The SBOM, provenance attestation, signature, license/NOTICE inventory, and
   container security scan stored with the release.
5. Golden results and the full parity matrix; every existing plan keeps its
   original image identity and remains replayable.

## Build and publish (release pipeline only)

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/finny-ai/lean-engine:<commit> \
  --tag ghcr.io/finny-ai/lean-engine:latest \
  --provenance=true --sbom=true \
  --push .
```

Record the multi-arch digest (`docker buildx imagetools inspect`) into
`LEAN_PINNED_IMAGE_DIGEST` and sign the image with the Finny release key.

## Runtime posture

Run containers are spawned by `LeanAdapter` with: no network, non-root user
`10001`, read-only root/data/algorithm mounts, tmpfs scratch, `--cap-drop ALL`,
`no-new-privileges`, PID/memory/CPU limits, and a controller-owned wall clock.
The launcher config is generated deterministically by `engine-config.ts` and
hashed into every run identity. Run containers never download data, never
compile, and never contact QuantConnect.
