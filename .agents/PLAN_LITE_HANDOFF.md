# Lite tier — off-repo handoff (finnyai.tech)

The Finny CLI changes for the **Lite** tier ship in this repo. Stripe + the
license-signing service live on **finnyai.tech** and need matching changes.

## What the CLI now expects

- License code format: `FINNY-LITE-<uuid>.<base64url_signature>`
  - Same Ed25519 keypair as Pro (the embedded public key in
    `packages/opencode/src/plan/index.ts` already verifies both prefixes).
  - Payload (the part signed) is the `<uuid>`. Same as Pro.
- The user pastes the code into Settings → Plan in the CLI. The CLI stores it
  in `~/.opencode/auth.json` under provider id `finny-lite` (Pro stays in
  `finny-pro`). Both can coexist; the CLI uses the highest-tier one.

## Server work

### 1. Stripe — Lite product

- Create a Stripe product **"Finny Lite"**, recurring **$10 USD / month**.
  - Description: *Managed cloud trading for retail traders. 10 strategies,
    10 backtests/day, 3 terminal + 1 cloud live run. Alpaca, Polymarket,
    Binance. BYOK + metered models. Discord Lite badge.*
  - No trial (mirror Pro).
- Export `LITE_PRICE_ID` env var (alongside the existing `PRO_PRICE_ID`).

### 2. Checkout

- Update the checkout-session creator to accept a `plan: "lite" | "pro"` arg
  and route to the matching price ID.
- Routes / pages:
  - `finnyai.tech/lite` → starts Lite checkout.
  - `finnyai.tech/pro` (existing) → unchanged.

### 3. Webhook (`stripe/webhook` handler)

Handle the same three events for both Lite and Pro:

- `checkout.session.completed` → mint a **`FINNY-LITE-<uuid>.<sig>`** for Lite
  purchases (or `FINNY-PRO-...` for Pro), email it to the customer, and store
  it server-side keyed by the Stripe `customer` id + `subscription` id.
- `customer.subscription.updated` →
  - On upgrade Lite → Pro: mint a new Pro code, email it. (Lite code remains
    valid offline forever — that's fine; the user just pastes Pro and the CLI
    picks the higher tier.)
  - On downgrade Pro → Lite: mint a new Lite code, email it. The old Pro code
    is *not* revocable offline; rely on the user pasting the new Lite code.
    (If hard revocation is ever needed, switch to short-lived JWTs — out of
    scope for v1.)
- `customer.subscription.deleted` → mark the server-side record canceled.
  No CLI-side action needed; the user can simply remove the license in the
  Settings panel.

### 4. Customer portal — upgrade/downgrade between Lite and Pro

- Enable Stripe Customer Portal with both prices listed as switchable plans.
- On plan switch, Stripe fires `customer.subscription.updated`; the webhook
  above mints + emails the new code. No "cancel and re-subscribe" flow.

### 5. Server-side caps that the CLI cannot enforce

- **Cloud live runs**: 1 (Lite) / 5 (Pro). The CLI gates the request form
  but the actual deploy queue lives server-side; enforce the cap there.
- **Top-tier model metering**: monthly token allowance for Lite + (higher)
  Pro. When exhausted, the CLI falls back to BYOK for the rest of the month.
  The CLI has a `Plan.modelAllowance()` placeholder but the real meter is
  server-side.

### 6. Out of scope (explicit per spec)

- Founding-member coupon ($29/mo lifetime for first 50 Pro signups). Add as
  a separate Stripe coupon code if/when desired.
- Telegram bot, TradingView webhook ingress, analytics dashboard — not yet
  built. CLI shows "Pro feature" upsell on the Settings panel only.

## Test plan (server-side)

- Buy Lite via Stripe test card → webhook mints `FINNY-LITE-...` code → email
  delivered → CLI accepts the code → `Plan.getTier()` returns `"lite"`.
- Tamper one byte of the signature → CLI rejects the code (`getTier()`
  returns `"free"`).
- Upgrade Lite → Pro via Customer Portal → new `FINNY-PRO-...` code emailed
  → CLI accepts it → `Plan.getTier()` returns `"pro"` (Lite code untouched).
- Downgrade Pro → Lite → new Lite code emailed → user pastes it → tier
  returns `"lite"` (old Pro code is now stale but still locally valid; user
  must remove it manually in Settings if they want their CLI to reflect the
  downgrade).
