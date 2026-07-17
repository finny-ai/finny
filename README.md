```
                                    ███████╗██╗███╗   ██╗███╗   ██╗██╗   ██╗
                                    ██╔════╝██║████╗  ██║████╗  ██║╚██╗ ██╔╝
                                    █████╗  ██║██╔██╗ ██║██╔██╗ ██║ ╚████╔╝
                                    ██╔══╝  ██║██║╚██╗██║██║╚██╗██║  ╚██╔╝
                                    ██║     ██║██║ ╚████║██║ ╚████║   ██║
                                    ╚═╝     ╚═╝╚═╝  ╚═══╝╚═╝  ╚═══╝   ╚═╝

                                      Claude Code for Financial Markets
```
<a href="https://www.npmjs.com/package/finny-pro"><img alt="npm" src="https://img.shields.io/badge/npm-finny--pro-3381C3?style=flat-square" /></a>

<img width="1546" height="1046" alt="Screenshot 2026-04-14 at 4 55 14 PM" src="https://github.com/user-attachments/assets/be2784d6-ced1-4259-96de-69518f22b444" />

Build, backtest, and iterate on trading algorithms using natural language. Built on the [OpenCode](https://github.com/anomalyco/opencode) AI agent harness.

---

### Quick Start

```bash
npm i -g finny-pro
finny-pro --license-key finny_...
```

> **Try it:** _"Build me a momentum-based ETH trading strategy with RSI signals"_

---

### Agent Modes

Press `Tab` to switch between modes.

| Mode | Description |
| --- | --- |
| **Build** | Generates algorithms immediately. No questions asked. |
| **Research** | Asks clarifying questions, fetches market data, runs analysis, then transitions to Build. |
| **Chat** | Conversational assistant for strategy questions, portfolio review, market data. |

---

### How It Works

1. **Describe** what you want in plain English
2. The agent generates a Python `Strategy` class (7 built-in templates available)
3. Code is **auto-validated** — syntax, safety, and trading best practices
4. Algorithm saved to **cloud storage** (Convex) with version tracking
5. Run **backtests** against historical data
6. **Iterate** — modify, re-validate, compare versions

---

### Strategy Templates

| Template | Description |
| --- | --- |
| Momentum | RSI momentum — buys oversold, sells overbought |
| Mean Reversion | Bollinger Bands — buys at lower band, sells at upper |
| Breakout | Donchian channel — buys new highs, sells new lows |
| DCA | Dollar-cost averaging — systematic buying with profit-target exit |
| Golden Cross | SMA 50/200 crossover — buys golden cross, sells death cross |
| Scalping | EMA scalping with tight stops — quick entries and exits |
| Custom | Minimal skeleton — implement your own logic |

---

### Commands

| Command | Description |
| --- | --- |
| `/algos` | List saved algorithms |
| `/code` | View algorithm source code |
| `/backtest` | Run historical backtest |
| `/review` | Review strategy changes (commit, branch, or PR) |
| `/init` | Initialize project rules for strategy generation |

---

### Backtesting

- Historical data via **yfinance**
- Configurable duration, interval, and starting capital
- Metrics: Total Return, Sharpe Ratio, Max Drawdown, Win Rate, Profit Factor
- Interactive TUI for parameter selection and results display

---

### Validation

Every generated strategy is checked for:

- **Python syntax** errors
- **Strategy class structure** — strict v2 requires `Strategy(broker, params=None)` and `on_bar(self, symbol, bar)`
- **Forbidden imports** — `os`, `subprocess`, `socket`, `requests`, etc.
- **Dangerous calls** — `exec`, `eval`, `compile`, `__import__`
- **Trading pitfalls** — lookahead bias, unbounded lists, division by zero

---

### Configuration

**BYOK** — bring your own AI API keys. Works with Anthropic, OpenAI, Google, or local models.

Supported assets include crypto (BTC, ETH, SOL) and stocks (AAPL, NVDA, PLTR).

Config is stored in XDG-compliant directories:

```
~/.config/finny/    # configuration
~/.local/share/finny/  # data
```

---

### Tech Stack

TypeScript / Bun / Turbo monorepo. Solid.js TUI. Convex DB. Python backtesting engine.

Fork of [OpenCode](https://github.com/anomalyco/opencode) by Anomaly.

---

### License

Finny is available for noncommercial use under the
[Finny Source-Available License 1.0](./LICENSE) (PolyForm Noncommercial
1.0.0 with Additional Conditions).

In short: you may use official Finny releases and read the source freely.
If you fork or modify Finny, you must publish your changed source publicly
within 30 days — private forks are not licensed. Nobody may host Finny, or
any fork of it, as a web or network service for others. Commercial or
enterprise use requires prior written approval from Finny and a separate
commercial license agreement.

The original OpenCode codebase is licensed under the MIT License. Finny's
modifications and new features are licensed under the Finny Source-Available
License 1.0.

---

### Acknowledgments

Built on [OpenCode](https://github.com/anomalyco/opencode) by [Anomaly](https://github.com/anomalyco).
