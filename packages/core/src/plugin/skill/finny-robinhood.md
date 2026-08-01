<!--
  Built-in Finny skill. The name and description are registered in code.
  Keep this content free of user-specific account data and local paths.
-->

# Robinhood in Finny

Use Finny's managed Robinhood connector for Robinhood account and brokerage work.
The connector is powered by the pinned `rhx` package, but Robinhood credentials,
MFA challenges, API keys, and authenticated sessions remain owned by RHX. Never
ask the user to paste those secrets into chat, source files, environment files,
tool arguments, or Finny settings.

## Connection and recovery

- Direct users to `/robinhood` to install, connect, verify, reconnect, or remove
  the connector.
- Robinhood stock authentication can require an interactive terminal MFA or app
  approval step. Do not loop non-interactive login attempts when the connector
  reports that user action is required.
- Robinhood Crypto API credentials are configured separately through Robinhood's
  official Crypto API settings. Do not claim that a successful stock login also
  enables crypto access.
- Do not expose RHX profiles, executable paths, usernames, account identifiers,
  balances, tokens, keys, cookies, challenge responses, or raw authentication
  output to the model.

## Brokerage behavior

- Use Finny's broker interfaces and policy gates. Do not shell out to raw RHX
  order commands from generated strategies.
- Treat the RHX stock and ETF surface as an unofficial beta integration. Explain
  that Robinhood can change or restrict those endpoints.
- Treat Robinhood Crypto as a separate official API capability. Crypto symbols
  use Finny's normalized form such as `BTC-USD`; stocks and ETFs use symbols such
  as `AAPL` and `SPY`.
- Use finalized OHLCV bars from Finny's configured market-data provider for
  strategy decisions. Brokerage connectivity does not imply historical data
  availability.
- Respect the runtime's live-trading eligibility checks, explicit confirmation
  token, and fail-closed policy. A connected broker is not permission to place
  live orders. If submission is disabled, remain in shadow or simulation mode
  and say so plainly.

## Safe responses

Report only capability-level state: whether the connector is installed, whether
authentication needs attention, which asset classes are available, and whether
orders are simulated or live-eligible. If setup is incomplete, give the next
action without inventing account details or requesting secrets.
