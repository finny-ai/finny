import { Python } from "@/python/env"
import { BrokerRegistry } from "./brokers"

export namespace PythonEnv {
  // Always-required packages (independent of any broker).
  const BASE_PACKAGES: Python.PackageRequirement[] = [{ spec: "pytz", importCheck: "pytz" }]

  function requiredPackages(): Python.PackageRequirement[] {
    return [...BASE_PACKAGES, ...BrokerRegistry.unionPythonDeps()]
  }

  export type ProgressCallback = Python.ProgressCallback
  export type Environment = Python.Environment

  /**
   * Ensure a managed Python env exists with the broker-required packages
   * installed. See {@link Python.ensurePythonEnv} for the underlying helper —
   * this wrapper exists so live callers don't need to know which packages
   * the brokers in use depend on.
   */
  export function ensure(onProgress: ProgressCallback = () => {}): Promise<Environment> {
    return Python.ensurePythonEnv(requiredPackages(), onProgress)
  }

  export function reset(): Promise<void> {
    return Python.reset()
  }
}
