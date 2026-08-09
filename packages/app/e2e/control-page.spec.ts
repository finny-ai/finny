import { expect, test } from "@playwright/test"

test("control panel renders live agents, crucible stages, and campaign data", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))

  await page.goto("/control")
  await expect(page.getByText("Control", { exact: true }).first()).toBeVisible({ timeout: 20_000 })

  // The page polls /control/v1/overview; the live server has one session card
  // titled "Control E2E SPY build" plus a finished Crucible workflow.
  await expect(page.getByText("Control E2E SPY build").first()).toBeVisible({ timeout: 20_000 })

  // Health chips render per domain.
  await expect(page.getByText(/agents/i).first()).toBeVisible()
  await expect(page.getByText(/crucible/i).first()).toBeVisible()

  // Crucible workflow card surfaces the engine stage badge and the section.
  await expect(page.getByText(/candidate_ready|backtested|reviewable|strict_running/i).first()).toBeVisible({
    timeout: 20_000,
  })

  // No page-level JavaScript errors (network fetch failures are handled inline).
  expect(errors).toEqual([])
})
