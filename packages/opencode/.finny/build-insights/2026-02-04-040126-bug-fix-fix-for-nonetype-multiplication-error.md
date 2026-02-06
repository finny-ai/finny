---
title: "Fix for NoneType multiplication error"
category: bug-fix
priority: high
created: 2026-02-04T04:01:26.933Z
tags: ["critical-fix", "bollinger-bands", "python-trading-algorithm"]
---

# Fix for NoneType multiplication error

**Category:** 🐛 bug-fix | **Priority:** high | **Tags:** critical-fix, bollinger-bands, python-trading-algorithm

*Saved: 2026-02-04T04:01:26.933Z*

## Insight

Resolved a critical bug where multiplication with NoneType caused execution failure in trailing stop profit calculations.

## Code

```python
if self.entry_price is not None: profit_target = self.entry_price * 1.12
```

---

*Saved by Finny Build Agent*