import type { BrokerSpec } from "./types"

/**
 * QuantConnect broker spec.
 *
 * QC is a control-plane execution backend: Finny deploys to the client's own
 * QuantConnect Paper brokerage through the QC Cloud API. It never spawns a
 * local Finny worker, so this spec is data_only and has no python class.
 */
export const qcSpec: BrokerSpec = {
  kind: "qc",
  displayName: "QuantConnect",
  mode: "paper",
  providerPrefix: "qc",
  pythonClass: "",
  pythonDeps: [],
  assetClasses: ["equity", "crypto"],
  staticTakerFee: 0,
  defaultEndpoint: "https://www.quantconnect.com",
  docsUrl: "https://www.quantconnect.com/docs/v2/cloud-platform/api-reference",
  credentialFields: [
    { name: "label", label: "Label" },
    { name: "keyId", label: "QC user id", required: true },
    { name: "secret", label: "QC API token", secret: true, required: true },
  ],
  promptFragment:
    "QuantConnect projects run through the Finny QC-Native control plane: link a project, sync sources, and deploy approved runs to QC Paper.",
  executionSupport: "data_only",
  normalizeSymbol(canonical: string) {
    return canonical.toUpperCase()
  },
  resolvePair(canonical: string) {
    return canonical.toUpperCase()
  },
  detectAssetClass(canonical: string) {
    const upper = canonical.toUpperCase()
    if (upper.endsWith("USD") && !upper.endsWith("USD=")) return "crypto"
    return "equity"
  },
  envVars() {
    return {}
  },
}
