---
title: "Avoid TypeError multiplying NoneType in entry/exit logic"
category: bug-fix
priority: high
created: 2026-02-04T03:59:04.272Z
strategy: "btc_swing_trading"
tags: ["bugfix", "bollingerbands", "trading-algorithm", "python"]
---

# Avoid TypeError multiplying NoneType in entry/exit logic

**Category:** 🐛 bug-fix | **Priority:** high | **Strategy:** btc_swing_trading | **Tags:** bugfix, bollingerbands, trading-algorithm, python

*Saved: 2026-02-04T03:59:04.272Z*

## Insight

Fixed an issue where accessing NoneType leads to TypeError during profit target calculation (self.entry_price multiplication). Safeguarded by adding a `None` check for self.entry_price in on_tick().

## Code

```python
if self.entry_price is not None: profit_target = self.entry_price * 1.10
```

---

*Saved by Finny Build Agent*