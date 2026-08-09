import { describe, expect, test } from "bun:test"
import { csharpProjectScript } from "../../src/backtest/lean/adapter"

describe("LEAN C# compile project", () => {
  test("builds a deterministic offline project script", () => {
    const first = csharpProjectScript()
    const second = csharpProjectScript()
    expect(first).toBe(second)
    // The project must reference only baked-in engine assemblies, never NuGet.
    expect(first).toContain("RestoreSources")
    expect(first).toContain("<Compile Include=\"/build/**/*.cs\" />")
    expect(first).toContain("HintPath")
    // No package restore, deterministic output.
    expect(first).toContain("RestoreSources></RestoreSources>")
    expect(first).toContain("Deterministic")
    expect(first).toContain("dotnet build /build/FinnyAlgorithm.csproj -c Release --nologo -v minimal -o /build/out")
    expect(first).toContain("test -f /build/out/Algorithm.dll")
  })

  test("targets the highest SDK major found in the container", () => {
    const script = csharpProjectScript()
    expect(script).toContain('SDK_MAJOR=$(dotnet --list-sdks | sed -n \'s/^\\([0-9]*\\)\\..*/\\1/p\' | sort -n | tail -1)')
    expect(script).toContain('TFM="net${SDK_MAJOR}.0"')
  })
})
