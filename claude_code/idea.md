# Finny + AlgoClash - Project Vision & Ideas

> **Last Updated:** January 29, 2026  
> **Version:** 0.2.0  
> **Status:** Phase 1 - Local Development

---

## 🎯 One-Liner

**Finny** — An AI-powered terminal agent that turns natural language into trading algorithms and deploys them to battle in AlgoClash.

---

## 📖 The Vision

### Phase 1: Local (v0.2.0) ← WE ARE HERE

```
┌─────────────────────────────────────────────────────────────────┐
│                    YOUR COMPUTER (100% Local)                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌─────────────────┐              ┌─────────────────┐         │
│   │     FINNY       │   /deploy    │   ALGOCLASH     │         │
│   │   (Terminal)    │─────────────►│   (Simulator)   │         │
│   │                 │  localhost   │                 │         │
│   │ • /build        │              │ • Paper trading │         │
│   │ • /research     │              │ • on_tick()     │         │
│   │ • /deploy       │              │ • P&L tracking  │         │
│   │                 │              │                 │         │
│   │ OpenCode fork   │              │ Already working │         │
│   └─────────────────┘              └─────────────────┘         │
│                                                                 │
│   Data: yfinance (historical) + financialdatasets.ai (live)    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 2: Hybrid Cloud (v0.3.0) — FUTURE

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   LOCAL (Finny)                    CLOUD (AlgoClash)            │
│   • /build                         • Paper trading              │
│   • /deploy ──────────────────────► • Leaderboards              │
│                                    • Dashboard                  │
│                                    • Community                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Current State (Phase 1)

### AlgoClash ✅ Already Working

| Component | Status |
|-----------|--------|
| Simulation engine | ✅ Working |
| Paper trading | ✅ Working |
| `on_tick()` execution | ✅ Working |
| Data feed (financialdatasets.ai) | ✅ Working |
| `/deploy` endpoint | ✅ Working |

### Finny v0.1 (Current)

| Component | Status |
|-----------|--------|
| `/build` command | ✅ Working |
| `/research` command | ✅ Working |
| `/deploy` command | ✅ Working |
| OpenCode fork | ❌ Not yet |

---

## 🎯 Phase 1 Goal (v0.2.0)

Fork OpenCode → Make it Finny → Works 100% locally with your existing AlgoClash.

```
Finny = OpenCode + Quant Agent + Deploy Tool + Validator
```

### What We Get From OpenCode (Free):
- ✅ Multi-provider LLM (Claude, GPT, Gemini, local)
- ✅ Terminal UI
- ✅ Shell/file tools
- ✅ Session management
- ✅ Plugin system

### What We Add:
- 🆕 `quant.md` — Financial system prompt
- 🆕 `/build` command — Generate strategy
- 🆕 `/deploy` command — Send to local AlgoClash
- 🆕 `/research` command — Analyze markets
- 🆕 Validator — Check for lookahead bias

---

## 📊 Data Sources

| Type | Source | Notes |
|------|--------|-------|
| **Historical** | yfinance | Free, Python library |
| **Real-time** | financialdatasets.ai | Current setup |
| **Backup** | Twelve Data | If needed |

---

## ✨ Phase 1 Features

- [ ] Fork sst/opencode → finny-ai/finny
- [ ] Create `.opencode/agent/quant.md`
- [ ] Add `/build` command
- [ ] Add `/deploy` command (POST to localhost)
- [ ] Add `/research` command
- [ ] Strategy validator (lookahead bias, security)
- [ ] Test full flow: NL → code → deploy → simulate

---

## ⚠️ Design Decisions

### 1. Everything Local (Phase 1)

```
Finny (terminal) ──► AlgoClash (localhost:8000)

No cloud. No internet required (except for LLM API).
```

### 2. LLM Generates Code Once

```
User → Finny (LLM) → Python code → Deploy → on_tick() runs (no LLM)
```

### 3. Strategy Format

```python
class Strategy:
    def __init__(self):
        self.position = 0
    
    def on_tick(self, bar: dict) -> str:
        # bar = {open, high, low, close, volume, timestamp}
        return 'HOLD'  # or 'BUY' or 'SELL'
```

### 4. Validation Before Deploy (AST-Based)

```
/deploy
   │
   ├─ Syntax check (ast.parse)
   ├─ Lookahead check (AST visitor, not regex!)
   ├─ Security check (forbidden imports/calls)
   │
   └─ ✅ Pass → Deploy to AlgoClash
      ❌ Fail → Show errors
```

**Why AST, not regex?**  
Regex can be bypassed: `c = 'close'; if bar[c] > 0:`  
AST parses actual code structure — no tricks work.

---

## 📅 Phase 1 Timeline

### Week 1: Fork & Setup
```
├── Fork sst/opencode → finny-ai/finny
├── Clone locally
├── Run OpenCode, understand structure
├── Create .opencode/agent/quant.md
└── Test: can it generate strategy code?
```

### Week 2: Commands & Deploy
```
├── Add /build command
├── Add /deploy command
├── Connect to local AlgoClash (localhost:8000)
├── Add /research command
└── Test full flow
```

### Week 3: Validator & Polish
```
├── Build strategy validator
├── Lookahead bias detection
├── Security checks
├── Error messages
└── Documentation
```

### Week 4: Testing & Release
```
├── End-to-end testing
├── Edge cases
├── README
└── v0.2.0 release
```

---

## 📝 Open Questions

### ✅ Resolved

1. ~~Cloud vs Local?~~ → **Local first (Phase 1)**
2. ~~Data source?~~ → **yfinance + financialdatasets.ai**
3. ~~Strategy format?~~ → **Python with `on_tick()`**
4. ~~MCP server needed?~~ → **No, use curl**

### ✅ Also Resolved

5. ~~AlgoClash port?~~ → **`localhost:8000`**
6. ~~Auth needed?~~ → **No auth in Phase 1 (local)**
7. ~~Metrics?~~ → **AlgoClash tracks P&L internally**

---

## 🗺️ Roadmap

| Version | Phase | What |
|---------|-------|------|
| **0.2.0** | **Local** | **Finny + AlgoClash on your machine** |
| 0.3.0 | Hybrid | Cloud AlgoClash with dashboard |
| 0.4.0 | Community | Leaderboards, user accounts |
| 1.0.0 | Production | Stable, documented, ready |

---

## 🔄 Changelog

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | Jan 24, 2026 | Initial vision (overcomplicated) |
| **0.2.0** | **Jan 29, 2026** | **Local-only setup, Phase 1** |

---

## 💭 Notes

```
- Keep it simple for Phase 1
- Everything local = easy to debug
- No cloud complexity yet
- Get the core flow working first
- Cloud/leaderboards = Phase 2
```

**Stateless (Phase 1):** Strategy state (position, history) resets when AlgoClash restarts. Accept it for now.

**AST Validator:** Use `ast` module, not regex. Regex can be bypassed.

**Schema Endpoint:** Optional `GET /schema` so Finny knows what fields exist.

---

*Next Review: After v0.2.0 release*