# Research Subagent — Visual TUI Workflow

How the researcher subagent looks and behaves in the Finny TUI, step by step.

---

## 1. User triggers research

The user is in **Build**, **Research**, or **Chat** mode and asks Finny to
research a topic:

```
┌─────────────────────────────────────────────────────────┐
│  finny · build · trump-china-swing                      │
│                                                         │
│  You: Research everything about trump's china visit     │
│       and how it might affect BABA, JD, PDD             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Finny dispatches the researcher

Finny calls `finny_research_dispatch` to validate the algo and build the
prompt, then dispatches via `task(mode: "background")`:

```
┌─────────────────────────────────────────────────────────┐
│  finny · build · trump-china-swing                      │
│                                                         │
│  ▸ finny_research_dispatch                              │
│    topic: "trump china visit impact on BABA JD PDD"     │
│    algorithm: "trump-china-swing"                       │
│    channels: ["trump", "china-us-news", "market-news"]  │
│    └ completed                                          │
│                                                         │
│  ▸ task                                                 │
│    ◉ researcher Task — Research: trump china visit      │
│    ↳ Delegating...                                      │
│                                                         │
│  I've dispatched a research subagent to investigate     │
│  Trump's China visit and its market impact. It's        │
│  searching the web and Discord channels now — I'll      │
│  notify you when results are ready. Want to work on     │
│  something else in the meantime?                        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**What the user sees:**
- A `finny_research_dispatch` tool call (collapsed, shows params)
- A `task` card with a spinner and the researcher agent's color
- The task card shows "Delegating..." while the subagent works
- Finny continues the conversation immediately

---

## 3. Researcher works in background

The researcher subagent runs in its own headless session. The TUI shows
live progress on the task card:

```
┌─────────────────────────────────────────────────────────┐
│  ▸ task                                                 │
│    ◉ researcher Task — Research: trump china visit      │
│    ↳ [websearch] "trump china visit may 2025"           │
│                                                         │
│  ... (user continues working, Finny keeps chatting) ... │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Then later:

```
│    ↳ [finny_discord_read] channel: trump, limit: 20     │
```

Then:

```
│    ↳ [webfetch] https://reuters.com/article/...         │
```

Then:

```
│    ↳ [write] data/news/headlines/2026-05-18.md          │
```

**The task card updates in real-time** showing which tool the researcher is
currently calling. The user can click the task card to navigate into the
researcher's session and see full details.

---

## 4. Researcher completes and injects results

When the researcher finishes, the result is injected back into the parent
session via `Inject.post()`. The task card updates:

```
┌─────────────────────────────────────────────────────────┐
│  ▸ task                                                 │
│    ◉ researcher Task — Research: trump china visit      │
│    └ 14 toolcalls · 45s                                 │
│                                                         │
│  ┌─ Background task completed ─────────────────────┐    │
│  │                                                  │    │
│  │  ## Research Complete: trump china visit          │    │
│  │                                                  │    │
│  │  **Sources checked:** 12 web + 35 Discord posts  │    │
│  │  **Articles written:** 6 body files              │    │
│  │  **Headlines written:** 2 files (May 17-18)      │    │
│  │  **Duplicates removed:** 8 items                 │    │
│  │                                                  │    │
│  │  ### Key findings                                │    │
│  │  1. Trump announced 25% tariff reduction         │    │
│  │  2. Beijing signaled reciprocal measures          │    │
│  │  3. BABA, JD, PDD up 3-5% pre-market            │    │
│  │                                                  │    │
│  │  ### Files written                               │    │
│  │  - data/news/headlines/2026-05-17.md             │    │
│  │  - data/news/headlines/2026-05-18.md             │    │
│  │  - data/news/body/trump-tariff-reduction.md      │    │
│  │  - data/news/body/beijing-reciprocal.md          │    │
│  │  - data/news/body/markets-rally-trade-thaw.md    │    │
│  │  - ... 3 more                                    │    │
│  │                                                  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                         │
│  Finny: Great — the research is in. Here's what I       │
│  found relevant for your trump-china-swing strategy:    │
│  ...                                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**What happens:**
- The task card stops spinning and shows total tool calls + duration
- The injected result appears as a system message in the conversation
- Finny reads the summary and incorporates the findings into its response
- If the user was idle, an OS notification fires too

---

## 5. Finny reads the research data

After the researcher writes files, Finny can read them using the standard
progressive-disclosure pattern from the algo template:

```
Step 1: List headline dates
  → ls data/news/headlines/
  → 2026-05-17.md  2026-05-18.md

Step 2: Read today's headlines
  → cat data/news/headlines/2026-05-18.md

  # Headlines — 2026-05-18

  | Time (UTC) | Headline                              | Source   | Slug                          |
  |------------|---------------------------------------|----------|-------------------------------|
  | 09:15      | Trump announces 25% tariff reduction  | Reuters  | trump-tariff-reduction        |
  | 10:30      | Beijing welcomes tariff reduction      | SCMP     | beijing-welcomes-reduction    |
  | 14:00      | Markets rally on trade thaw           | Bloomberg| markets-rally-trade-thaw      |

Step 3: Open a body file on demand
  → cat data/news/body/trump-tariff-reduction.md

  # Trump announces 25% tariff reduction on Chinese goods

  **Date:** 2026-05-18 09:15 UTC
  **Source:** Reuters
  **Relevance:** Direct catalyst for BABA, JD, PDD positions.

  ## Summary
  ...

  ## Market Impact
  BABA +4.2%, JD +3.8%, PDD +5.1% pre-market.

  ## Citations
  - [Reuters](https://reuters.com/...) — Breaking report
```

**Key:** Finny reads headlines first (cheap), then opens body files only when
it needs the full context. This is the `data/` progressive-disclosure contract.

---

## 6. Where the researcher does NOT appear

- **Tab bar:** The researcher is `mode: subagent` + `hidden: true`. It does NOT
  appear in the mode switcher (Build / Research / Chat / Portfolio Builder).
  Users cannot switch to it.
- **Agent list:** It's hidden from `agent.list()` output.
- **Direct access:** Users never interact with the researcher directly. They
  interact with Finny, and Finny dispatches the researcher.

---

## Data flow diagram

```
User → Finny (build/research/chat)
         │
         ├── finny_research_dispatch(topic, algo)
         │     └── validates algo, creates dirs, returns prompt
         │
         └── task(subagent_type: "researcher", prompt, mode: "background")
               │
               └── Researcher subagent (headless session)
                     │
                     ├── websearch("trump china visit 2025")
                     ├── websearch("trump china market impact")
                     ├── webfetch(reuters.com/article/...)
                     ├── finny_discord_read(channel: "trump", limit: 20)
                     ├── finny_discord_read(channel: "china-us-news", limit: 20)
                     │
                     ├── [LLM deduplication pass]
                     │
                     ├── write(data/news/headlines/2026-05-18.md)
                     ├── write(data/news/body/trump-tariff-reduction.md)
                     ├── write(data/news/body/beijing-reciprocal.md)
                     └── ... more body files
                     │
                     └── Returns summary → Inject.post() → Parent session
                                                              │
                                                              └── Finny reads & responds
```

---

## Error states

| State | What the user sees |
|-------|-------------------|
| Algo not found | `finny_research_dispatch` returns error, Finny tells user to create the algo first |
| Researcher blocked (permission denied) | Task card shows "BLOCKED: ..." message, Finny explains what went wrong |
| Researcher failed (timeout, crash) | Task card shows "FAILED: ..." message with error |
| No results found | Researcher returns summary saying "0 articles written, topic yielded no results" |
| User cancels | `stop_task` kills the researcher session |
