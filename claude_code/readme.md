# Finny Documentation

This folder contains documentation and guides for the Finny project.

## Files

| File | Description |
|------|-------------|
| [claude.md](./claude.md) | Instructions for AI coding assistants (Claude Code) |
| [idea.md](./idea.md) | Project vision, roadmap, and design decisions |
| [architecutre.md](./architecutre.md) | Technical architecture and system design |
| [example.md](./example.md) | Example strategies and usage patterns |
| [starter_files.md](./starter_files.md) | Templates and starter code |
| [tasks.md](./tasks.md) | Current tasks and TODO items |

## Quick Start

1. **Read the vision**: Start with [idea.md](./idea.md) to understand what Finny does
2. **Understand the architecture**: Review [architecutre.md](./architecutre.md) for technical details
3. **See examples**: Check [example.md](./example.md) for working strategy examples
4. **Start coding**: Use [starter_files.md](./starter_files.md) as templates

## What is Finny?

Finny is an AI-powered terminal agent that:
- Turns natural language into trading algorithms
- Validates strategies for safety and correctness
- Deploys them to AlgoClash for paper trading

```
User: "Build an RSI momentum strategy for BTC"
  -> Finny generates Python code
  -> Validator checks for lookahead bias
  -> Deploy to AlgoClash (localhost:8000)
  -> Watch it trade in real-time
```

## Tech Stack

- **Runtime**: Bun
- **Core**: TypeScript (forked from OpenCode)
- **Strategies**: Python
- **LLM**: Claude, OpenAI, Gemini

## Key Commands

```bash
# Research a symbol
/research AAPL

# Build a strategy
/build momentum strategy using RSI for BTC

# Deploy to AlgoClash
/deploy
```

## Links

- [Main README](../README.md)
- [AlgoClash Simulator](../simulator/)
- [Strategy Folder](../packages/finny/strategies/)
