import { describe, expect, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { CampaignApi } from "../../src/server/routes/instance/httpapi/groups/campaign"

describe("campaign HttpApi contract", () => {
  test("publishes the complete parent-harness control surface", () => {
    const spec = OpenApi.fromApi(CampaignApi) as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    const expected = [
      ["post", "/experimental/campaign"],
      ["get", "/experimental/campaign/{campaignID}"],
      ["post", "/experimental/campaign/{campaignID}/candidate/{candidateID}/start"],
      ["post", "/experimental/campaign/{campaignID}/continue"],
      ["post", "/experimental/campaign/{campaignID}/abort"],
      ["post", "/experimental/campaign/{campaignID}/artifact"],
      ["get", "/experimental/campaign/{campaignID}/event"],
      ["get", "/experimental/campaign/{campaignID}/wait"],
      ["get", "/experimental/campaign/{campaignID}/comparison"],
      ["post", "/experimental/campaign/{campaignID}/advance"],
    ] as const

    for (const [method, path] of expected) expect(spec.paths[path]?.[method]).toBeDefined()
  })
})
