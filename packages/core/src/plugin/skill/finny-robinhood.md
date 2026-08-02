<!--
  Built-in Finny skill. The name and description are registered in code.
  Keep this content free of user-specific account data and local paths.
-->

# Robinhood in Finny

Finny has two separate Robinhood surfaces:

1. The first-party Robinhood Trading MCP is an authenticated remote server for
   Robinhood account and market-data reads. In managed cloud deployments,
   Platform v3 owns durable OAuth and Finny receives only a secret-free loopback
   URL for a runner-local, per-session MCP broker. Direct local CLI connections
   to Robinhood's official endpoint use OpenCode's local OAuth storage instead.
2. The legacy managed connector uses the pinned `rhx` package. RHX owns its own
   credentials, MFA challenges, API keys, and authenticated sessions.

Never ask the user to paste Robinhood secrets into chat, source files,
environment files, tool arguments, or Finny settings.

## Official Trading MCP v1

- Treat the official MCP as read-only in Finny even if its server advertises
  mutation tools or marks an unknown tool read-only.
- Managed cloud deployments use only the injected loopback broker. Platform
  mints narrowly scoped capabilities with a maximum 90-second lifespan and
  renews them server-side; managed Finny receives neither upstream Robinhood
  tokens nor Platform capability tokens.
- A local Finny CLI may connect the canonical `robinhood` server directly to
  `https://agent.robinhood.com/mcp/trading`. That path uses MCP OAuth and stores
  its Robinhood OAuth material in local OpenCode auth storage. Never represent
  the direct local path as the managed cloud custody model.
- The exact allowed tool names are `get_accounts`, `get_portfolio`,
  `get_equity_positions`, `get_equity_quotes`, `get_equity_orders`,
  `get_equity_tradability`, `search`, `get_popular_watchlists`, and
  `get_watchlists`.
- Order review, placement, replacement, and cancellation are unavailable.
  Watchlist mutations and every unknown tool are also unavailable.
- Use the MCP for equities account context, portfolio and position reads,
  quotes, order history, tradability, search, and watchlists. Do not
  imply that this read surface makes a strategy paper- or live-eligible.
- Do not expose the remote URL, request headers, tokens, or raw authentication
  output in prompts or logs.

## RHX connection and recovery

- Direct users to `/robinhood` to install, connect, verify, reconnect, or remove
  the connector.
- Robinhood stock authentication can require an interactive terminal MFA or app
  approval step. Do not loop non-interactive login attempts when the connector
  reports that user action is required.
- Robinhood Crypto API credentials are configured separately through Robinhood's
  official Crypto API settings. Do not claim that a successful stock login also
  enables crypto access.
- Do not expose RHX profiles, executable paths, usernames, tokens, keys,
  cookies, challenge responses, or raw authentication output to the model.

## RHX brokerage behavior

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
- RHX is always shadow-only. Workers may read account, position, and quote data,
  but they must never submit orders through RHX. Keep RHX runs in shadow or
  simulation mode and state this plainly.

## Safe responses

Report only capability-level state: which Robinhood surface is connected,
whether authentication needs attention, which data classes are available, and
whether actions are read-only or simulated. If setup is incomplete, give the
next action without inventing account details or requesting secrets.
