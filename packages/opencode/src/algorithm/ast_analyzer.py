"""Finny strategy AST analyzer.

Reads Python source on stdin, emits a JSON array of diagnostics on stdout.
Optional CLI args: --symbol <symbol>  (informs FRACTIONAL_SHARES_EQUITY).
Each diagnostic: {code, severity, message, line?, fix?}.

Diagnostic codes:
  STATE_RESET_IN_ON_TICK    (error)   local mutable container assigned inside on_tick
  GAINS_LOSSES_ASYMMETRY    (error)   self.gains* without matching self.losses* (or vice versa)
  LOOKAHEAD_BIAS_FLOW       (error)   bar["close"|"high"|"low"] flows into a condition that guards BUY/SELL
  SAME_BAR_EXECUTION_BIAS   (error)   self.X.append(current-bar value) precedes a BUY/SELL that depends on self.X
  EQUITY_NEVER_UPDATED      (error)   self.equity (or similar) read in sizing but never reassigned outside __init__
  RMS_NOT_STDDEV            (warning) sqrt(sum(x**2 ...)/N) with no mean subtraction
  POPULATION_VARIANCE       (warning) sum((p - mean)**2 ...) / N instead of /(N-1)
  MISSING_POSITION_SIZING   (warning) self.position only set to 0/1 with no sizing arithmetic
  POSITION_SIZE_UNCAPPED    (warning) qty sized from risk/stop with no cap against equity
  FRACTIONAL_SHARES_EQUITY  (warning) symbol looks like an equity ticker but qty is a float
  NEAR_ZERO_DIVISION        (warning) RSI-shaped division guarded only by != 0 / > 0

Exits 0 on success (diagnostics on stdout). Exits non-zero only on parse failure.
"""
import argparse
import ast
import json
import sys


MUTABLE_CONTAINER_CALLS = {"deque", "list", "dict", "set", "defaultdict", "OrderedDict", "Counter"}
GROWTH_METHODS = {"append", "add", "update", "extend", "appendleft", "push"}

# Entry methods in priority order — both the legacy on_tick and the broker-based on_bar
# get checked. Strategies may define either one or, rarely, both.
ENTRY_METHOD_NAMES = ("on_bar", "on_tick", "handle_bar", "step", "next", "process_bar")
PRIVATE_STRATEGY_ATTRS = {"_broker", "_market", "_account", "account", "market"}
REFLECTION_CALLS = {"getattr", "setattr", "delattr", "vars", "dir", "globals", "locals"}
DISALLOWED_CALLS = {"eval", "exec", "compile", "__import__", "open", "input"}


def _find_class(tree, name):
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    return None


def _find_method(cls, name):
    for node in cls.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    return None


def _find_entry_methods(cls):
    """Return all entry methods defined on the class (could be on_bar, on_tick, etc.)."""
    out = []
    for name in ENTRY_METHOD_NAMES:
        m = _find_method(cls, name)
        if m is not None:
            out.append(m)
    return out


def _call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _string_constant(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def check_strict_security(tree, cls):
    diagnostics = []
    broker_aliases = {"broker"}
    changed = True
    while changed:
        changed = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            value = node.value
            is_broker_value = (
                isinstance(value, ast.Attribute)
                and isinstance(value.value, ast.Name)
                and value.value.id == "self"
                and value.attr == "broker"
            ) or (
                isinstance(value, ast.Name)
                and value.id in broker_aliases
            )
            if not is_broker_value:
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id not in broker_aliases:
                    broker_aliases.add(target.id)
                    changed = True

    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [a.name.split(".")[0] for a in getattr(node, "names", [])]
            if isinstance(node, ast.ImportFrom) and node.module:
                names.append(node.module.split(".")[0])
            for name in names:
                if name in {"os", "sys", "subprocess", "socket", "requests", "pickle", "threading", "asyncio", "pathlib"}:
                    diagnostics.append({
                        "code": "FORBIDDEN_IMPORT",
                        "severity": "error",
                        "message": f"Forbidden import `{name}` in strict strategy code.",
                        "line": node.lineno,
                        "fix": "Remove filesystem, network, process, and runtime imports from strategy code.",
                    })
                    return diagnostics
        if isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name in DISALLOWED_CALLS:
                diagnostics.append({
                    "code": "DANGEROUS_CALL",
                    "severity": "error",
                    "message": f"Dangerous call `{name}()` is not allowed in strict strategy code.",
                    "line": node.lineno,
                    "fix": "Remove dynamic code execution and filesystem calls.",
                })
                return diagnostics
            if name == "getattr" and len(node.args) >= 2:
                attr = _string_constant(node.args[1])
                if attr and (attr.startswith("_") or attr in PRIVATE_STRATEGY_ATTRS):
                    diagnostics.append({
                        "code": "PRIVATE_BROKER_ACCESS",
                        "severity": "error",
                        "message": f"Private attribute access `{attr}` is not allowed.",
                        "line": node.lineno,
                        "fix": "Use only public broker methods.",
                    })
                    return diagnostics
            if name in REFLECTION_CALLS:
                diagnostics.append({
                    "code": "FORBIDDEN_REFLECTION",
                    "severity": "error",
                    "message": f"Reflection call `{name}()` is not allowed because it can inspect or bypass broker internals.",
                    "line": node.lineno,
                    "fix": "Use only the public broker API: buy, sell, position, cash, equity, price, history.",
                })
                return diagnostics
        if isinstance(node, ast.Attribute):
            is_broker_private = (
                isinstance(node.value, ast.Attribute)
                and isinstance(node.value.value, ast.Name)
                and node.value.value.id == "self"
                and node.value.attr == "broker"
                and node.attr.startswith("_")
            )
            is_broker_alias_private = (
                isinstance(node.value, ast.Name)
                and node.value.id in broker_aliases
                and node.attr.startswith("_")
            )
            if is_broker_private or is_broker_alias_private or node.attr in PRIVATE_STRATEGY_ATTRS:
                diagnostics.append({
                    "code": "PRIVATE_BROKER_ACCESS",
                    "severity": "error",
                    "message": f"Private/internal attribute `.{node.attr}` is not allowed in strict strategy code.",
                    "line": node.lineno,
                    "fix": "Use only the strict broker proxy public API.",
                })
                return diagnostics
    return diagnostics


def _is_broker_trade_call(node):
    """True if node is `self.broker.buy(...)` or `self.broker.sell(...)` (or bare `broker.buy`)."""
    if not isinstance(node, ast.Call):
        return False
    func = node.func
    if not isinstance(func, ast.Attribute):
        return False
    if func.attr not in ("buy", "sell", "close", "short", "cover"):
        return False
    # Accept self.broker.buy OR broker.buy (local alias)
    receiver = func.value
    if isinstance(receiver, ast.Attribute):
        return (
            isinstance(receiver.value, ast.Name)
            and receiver.value.id == "self"
            and receiver.attr == "broker"
        )
    if isinstance(receiver, ast.Name) and receiver.id == "broker":
        return True
    return False


def _is_trade_signal_return(node):
    """True if node is `return "BUY"` or `return "SELL"` (but not HOLD)."""
    return (
        isinstance(node, ast.Return)
        and isinstance(node.value, ast.Constant)
        and node.value.value in ("BUY", "SELL")
    )


def _collect_trade_actions(entry_method):
    """Return list of (lineno, containing_if_node_or_None, kind) for every trade action
    in the entry method. kind is 'return-string' or 'broker-call'. For each action,
    walk up to the nearest enclosing `ast.If` so callers can examine the guard."""
    # Build a parent map so we can walk upward to the enclosing If.
    parents = {}
    for parent in ast.walk(entry_method):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent

    def enclosing_if(node):
        cur = parents.get(node)
        while cur is not None and not isinstance(cur, ast.If):
            cur = parents.get(cur)
        return cur if isinstance(cur, ast.If) else None

    out = []
    for node in ast.walk(entry_method):
        if _is_trade_signal_return(node):
            out.append((node.lineno, enclosing_if(node), "return-string"))
        elif _is_broker_trade_call(node):
            out.append((node.lineno, enclosing_if(node), "broker-call"))
    return out


def _is_mutable_container_init(value):
    """True if `value` constructs a mutable container: deque(...), [], {}, set(), etc."""
    if isinstance(value, (ast.List, ast.Dict, ast.Set)):
        return True
    if isinstance(value, ast.Call):
        func = value.func
        if isinstance(func, ast.Name) and func.id in MUTABLE_CONTAINER_CALLS:
            return True
        if isinstance(func, ast.Attribute) and func.attr in MUTABLE_CONTAINER_CALLS:
            return True
    return False


def check_state_reset_in_on_tick(on_tick):
    """Find locally-assigned mutable containers that are then mutated — the RSI losses bug.

    Pattern: `losses = deque(...)` followed by `losses.append(...)` — both inside on_tick,
    where `losses` is a bare Name (not self.losses). This means the container is reset
    every tick, so history is lost.
    """
    diagnostics = []
    local_containers = {}  # name -> line

    for node in ast.walk(on_tick):
        if isinstance(node, ast.Assign):
            if not _is_mutable_container_init(node.value):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    local_containers[target.id] = node.lineno

    if not local_containers:
        return diagnostics

    for node in ast.walk(on_tick):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in GROWTH_METHODS and isinstance(node.func.value, ast.Name):
                name = node.func.value.id
                if name in local_containers:
                    diagnostics.append({
                        "code": "STATE_RESET_IN_ON_TICK",
                        "severity": "error",
                        "message": (
                            f"Local `{name}` is created inside on_tick and then mutated — "
                            f"its contents reset every tick, destroying history."
                        ),
                        "line": local_containers[name],
                        "fix": (
                            f"Move `{name}` into __init__ as `self.{name} = ...` and use "
                            f"`self.{name}.append(...)` here."
                        ),
                    })
                    # one diagnostic per container is enough
                    del local_containers[name]
    return diagnostics


def check_gains_losses_asymmetry(cls):
    """Flag self.gains* persisted without a matching self.losses* (or vice versa)."""
    diagnostics = []
    self_attrs = set()

    for node in ast.walk(cls):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
            self_attrs.add(node.attr)

    has_gain = any("gain" in a.lower() for a in self_attrs)
    has_loss = any("loss" in a.lower() for a in self_attrs)

    # Also look for a *local* `losses` in on_tick that parallels a persisted `self.gains`.
    on_tick = _find_method(cls, "on_tick")
    local_loss = False
    local_gain = False
    if on_tick:
        for node in ast.walk(on_tick):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        low = target.id.lower()
                        if "loss" in low:
                            local_loss = True
                        if "gain" in low:
                            local_gain = True

    if has_gain and not has_loss and local_loss:
        diagnostics.append({
            "code": "GAINS_LOSSES_ASYMMETRY",
            "severity": "error",
            "message": (
                "Gains are persisted as `self.*` but losses are only a local variable in on_tick. "
                "RSI becomes invalid because the two series drift apart."
            ),
            "fix": "Persist losses the same way as gains (e.g. self.losses = deque(maxlen=...) in __init__).",
        })
    if has_loss and not has_gain and local_gain:
        diagnostics.append({
            "code": "GAINS_LOSSES_ASYMMETRY",
            "severity": "error",
            "message": (
                "Losses are persisted as `self.*` but gains are only a local variable in on_tick."
            ),
            "fix": "Persist gains as a self.* deque initialized in __init__.",
        })
    return diagnostics


def _is_sum_of_squares(call):
    """Detect sum(x**2 for x in ...)"""
    if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "sum"):
        return False
    if not call.args:
        return False
    arg = call.args[0]
    if not isinstance(arg, ast.GeneratorExp):
        return False
    elt = arg.elt
    if isinstance(elt, ast.BinOp) and isinstance(elt.op, ast.Pow):
        if isinstance(elt.right, ast.Constant) and elt.right.value == 2:
            # left must NOT be a subtraction (which would mean mean-centered squared deviations)
            return not (isinstance(elt.left, ast.BinOp) and isinstance(elt.left.op, ast.Sub))
    return False


def _is_sum_of_squared_deviations(call):
    """Detect sum((x - mean)**2 for x in ...)"""
    if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "sum"):
        return False
    if not call.args:
        return False
    arg = call.args[0]
    if not isinstance(arg, ast.GeneratorExp):
        return False
    elt = arg.elt
    if isinstance(elt, ast.BinOp) and isinstance(elt.op, ast.Pow):
        if isinstance(elt.right, ast.Constant) and elt.right.value == 2:
            if isinstance(elt.left, ast.BinOp) and isinstance(elt.left.op, ast.Sub):
                return True
    return False


def check_rms_not_stddev(tree):
    diagnostics = []
    for node in ast.walk(tree):
        # look for sqrt(...) wrapping Div wrapping sum_of_squares
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = None
        if isinstance(func, ast.Name):
            name = func.id
        elif isinstance(func, ast.Attribute):
            name = func.attr
        if name != "sqrt" or not node.args:
            continue
        inner = node.args[0]
        if isinstance(inner, ast.BinOp) and isinstance(inner.op, ast.Div):
            if _is_sum_of_squares(inner.left):
                diagnostics.append({
                    "code": "RMS_NOT_STDDEV",
                    "severity": "warning",
                    "message": (
                        "`sqrt(sum(x**2)/N)` computes RMS, not standard deviation. "
                        "Subtract the mean first: `sqrt(sum((x - mean)**2)/N)`."
                    ),
                    "line": node.lineno,
                    "fix": "Use `sum((x - mean) ** 2 for x in ...)`; otherwise volatility is overestimated.",
                })
    return diagnostics


def check_population_variance(tree):
    diagnostics = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)):
            continue
        if not _is_sum_of_squared_deviations(node.left):
            continue
        denom = node.right
        # Common "population" denominators: self.period, len(X), N
        is_pop = False
        if isinstance(denom, ast.Attribute) and isinstance(denom.value, ast.Name) and denom.value.id == "self":
            is_pop = True
        elif isinstance(denom, ast.Call) and isinstance(denom.func, ast.Name) and denom.func.id == "len":
            is_pop = True
        elif isinstance(denom, ast.Name):
            is_pop = True
        if is_pop:
            diagnostics.append({
                "code": "POPULATION_VARIANCE",
                "severity": "warning",
                "message": (
                    "Variance uses population denominator (/N). For a sample estimate, use /(N-1). "
                    "This systematically under-estimates stddev and inflates Sharpe."
                ),
                "line": node.lineno,
                "fix": "Divide by (n - 1) when n > 1, or use statistics.stdev().",
            })
            break  # one is enough
    return diagnostics


POST_BAR_FIELDS = {"close", "high", "low"}


def _is_bar_post_field(node):
    """True if `node` is bar["close"|"high"|"low"] — values only knowable after the bar closes."""
    return (
        isinstance(node, ast.Subscript)
        and isinstance(node.value, ast.Name)
        and node.value.id == "bar"
        and isinstance(node.slice, ast.Constant)
        and node.slice.value in POST_BAR_FIELDS
    )


def _bar_field_name(node):
    """Extract the field name if node is a bar[...] subscript, else None."""
    if not isinstance(node, ast.Subscript):
        return None
    if not (isinstance(node.value, ast.Name) and node.value.id == "bar"):
        return None
    if not isinstance(node.slice, ast.Constant):
        return None
    return node.slice.value


def _collect_names_from_expr(expr):
    names = set()
    for n in ast.walk(expr):
        if isinstance(n, ast.Name):
            names.add(n.id)
    return names


def _is_self_method_call(expr):
    """True if `expr` is `self.<something>(...)` — a method call on self."""
    return (
        isinstance(expr, ast.Call)
        and isinstance(expr.func, ast.Attribute)
        and isinstance(expr.func.value, ast.Name)
        and expr.func.value.id == "self"
    )


def _collect_names_skipping_self_method_args(expr):
    """Like _collect_names_from_expr but excludes Names that appear ONLY inside
    the argument list of `self.method(...)` calls. Rationale: self-methods can
    update internal state and return values computed from `self.*` history rather
    than from their arguments. Treating their return as tainted-by-args causes
    pervasive false positives on the common `rsi = self._update_rsi(close_px)`
    pattern. A real lookahead in this shape is rare; a model writing the
    comparison inline (`if bar["close"] > x:`) is still caught by the direct
    bar-field check.
    """
    safe_arg_names = set()
    for node in ast.walk(expr):
        if _is_self_method_call(node):
            for arg in node.args:
                for n in ast.walk(arg):
                    if isinstance(n, ast.Name):
                        safe_arg_names.add(n.id)
            for kw in node.keywords:
                for n in ast.walk(kw.value):
                    if isinstance(n, ast.Name):
                        safe_arg_names.add(n.id)

    all_names = _collect_names_from_expr(expr)
    # Names that appear OUTSIDE self-method args are still tracked normally.
    # We can't easily separate "in arg only" vs "in arg + elsewhere", so the
    # cleanest rule is: if a name appears anywhere outside a self-method arg,
    # it taints; otherwise it doesn't. Approximate by checking if the name has
    # ANY non-arg occurrence in the expr.
    non_arg_names = set()

    def walk_excluding_self_args(node):
        if _is_self_method_call(node):
            # Walk only func.value (which is self) — skip the args
            return
        if isinstance(node, ast.Name):
            non_arg_names.add(node.id)
        for child in ast.iter_child_nodes(node):
            walk_excluding_self_args(child)

    walk_excluding_self_args(expr)
    return all_names, non_arg_names


def _taint_source_for_expr(expr, tainted):
    """Return the field name (close/high/low) that would taint a target assigned
    from `expr`, or None if the assignment is safe.

    Three patterns are explicitly NOT propagated:

    1. Ternary `a if cond else b` only taints when BOTH branches independently
       taint. Defensive fallback `x if cond else bar["close"]` is unreachable
       after warmup.

    2. Direct `bar["close"]` reads inside the assigned expression always taint —
       there's no ambiguity.

    3. Method calls on `self` (`self.foo(close_px)`) do NOT propagate taint from
       their args to the return value. Self-methods commonly update internal
       state and return values computed from `self.*` history — flagging this
       as lookahead produces persistent false positives on the standard
       `rsi = self._update_rsi(close_px)` pattern. A name that appears ONLY
       inside self-method args is treated as safe; if it appears anywhere else
       in the expression it still taints.
    """
    if isinstance(expr, ast.IfExp):
        body_src = _taint_source_for_expr(expr.body, tainted)
        orelse_src = _taint_source_for_expr(expr.orelse, tainted)
        if body_src is not None and orelse_src is not None:
            return body_src
        return None

    rhs_post_fields = [n.slice.value for n in ast.walk(expr) if _is_bar_post_field(n)]
    if rhs_post_fields:
        return rhs_post_fields[0]

    _all_names, non_arg_names = _collect_names_skipping_self_method_args(expr)
    overlap = tainted.keys() & non_arg_names
    if overlap:
        return tainted[next(iter(overlap))]
    return None


def _expr_uses_only_self(expr):
    """True if `expr` references only self.* attributes, constants, and arithmetic on them.
    No bare local Names, no bar[...] subscripts. Used to recognize the stop-comparison
    pattern `bar["close"] <op> self.stop_price`.
    """
    safe = [True]

    def visit(node):
        if isinstance(node, ast.Attribute):
            # self.X — don't recurse into the Name("self") value
            if isinstance(node.value, ast.Name) and node.value.id == "self":
                return
            visit(node.value)
            return
        if isinstance(node, ast.Name):
            if node.id != "self":
                safe[0] = False
            return
        if isinstance(node, ast.Subscript):
            if _bar_field_name(node) is not None:
                safe[0] = False
                return
            visit(node.value)
            visit(node.slice)
            return
        for child in ast.iter_child_nodes(node):
            visit(child)

    visit(expr)
    return safe[0]


def _all_post_fields_are_stop_compares(test):
    """True if every bar[post_field] reference in `test` is inside a Compare node
    whose other operands reference only self.* attributes — the standard
    stop / take-profit / target exit pattern.

    Allows:   `bar["close"] < self.stop_price`
              `self.target >= bar["close"]`
              `bar["close"] > self.entry_px * (1 + self.profit_pct)`
    Rejects:  `bar["close"] > local_var`
              `bar["close"] > some_indicator_local`
    """
    post_subs = [n for n in ast.walk(test) if _is_bar_post_field(n)]
    if not post_subs:
        return False

    parents = {}
    for parent in ast.walk(test):
        for child in ast.iter_child_nodes(parent):
            parents[child] = parent

    def enclosing_compare(node):
        cur = parents.get(node)
        while cur is not None and not isinstance(cur, ast.Compare):
            cur = parents.get(cur)
        return cur

    for sub in post_subs:
        cmp = enclosing_compare(sub)
        if cmp is None:
            return False
        others = [e for e in [cmp.left, *cmp.comparators] if e is not sub]
        for other in others:
            if not _expr_uses_only_self(other):
                return False
    return True


def _trade_action_at(if_node, action_line):
    """Locate the trade-action node at `action_line` inside `if_node`.
    Returns the AST node (Call or Return) or None.
    """
    for node in ast.walk(if_node):
        if getattr(node, "lineno", None) != action_line:
            continue
        if isinstance(node, ast.Return) and isinstance(node.value, ast.Constant):
            if node.value.value in ("BUY", "SELL"):
                return node
        if _is_broker_trade_call(node):
            return node
    return None


def _is_exit_action(node):
    """True if `node` is a sell/close/cover broker call or `return "SELL"`."""
    if isinstance(node, ast.Return) and isinstance(node.value, ast.Constant):
        return node.value.value == "SELL"
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        return node.func.attr in ("sell", "close", "cover")
    return False


def check_lookahead_bias_flow(entry_method):
    """bar["close"|"high"|"low"] flows into a guard that gates any trade action
    (legacy string return OR broker.buy/sell call).

    Two patterns are explicitly NOT flagged (false positives the model spent
    many validation rounds fighting in production):

    1. Ternary fallback — taint only propagates through IfExp when BOTH
       branches independently taint. `x = self.X if cond else bar["close"]`
       is safe because the close branch is unreachable once warm.

    2. Stop comparison — `bar["close"] <op> self.stop_price` (or similar
       pure-self-attr expression on the other side) gating an EXIT
       (sell/close/cover/SELL). The stop level was set on a PRIOR bar;
       comparing the current close to it is standard end-of-bar exit logic,
       not lookahead.
    """
    diagnostics = []
    tainted = {}  # name -> field that tainted it
    post_field_lines = []

    for node in ast.walk(entry_method):
        if _is_bar_post_field(node):
            post_field_lines.append((node.lineno, node.slice.value))
        if isinstance(node, ast.Assign):
            field_source = _taint_source_for_expr(node.value, tainted)
            if field_source is not None:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        tainted[target.id] = field_source

    if not post_field_lines:
        return diagnostics

    for action_line, if_node, _kind in _collect_trade_actions(entry_method):
        if if_node is None:
            continue
        test = if_node.test
        test_post_fields = [n.slice.value for n in ast.walk(test) if _is_bar_post_field(n)]
        test_names = _collect_names_from_expr(test)
        tainting_names = test_names & tainted.keys()
        if not (test_post_fields or tainting_names):
            continue

        # Exit + stop-comparison exception: a sell/exit gated by a Compare of
        # bar[post] against a self.* expression is the standard stop pattern.
        if test_post_fields and not tainting_names:
            action_node = _trade_action_at(if_node, action_line)
            if action_node is not None and _is_exit_action(action_node):
                if _all_post_fields_are_stop_compares(test):
                    continue

        offending_field = (
            test_post_fields[0] if test_post_fields
            else tainted[next(iter(tainting_names))]
        )
        diagnostics.append({
            "code": "LOOKAHEAD_BIAS_FLOW",
            "severity": "error",
            "message": (
                f"Trade action (line {action_line}) is gated by `bar[\"{offending_field}\"]` "
                "(directly or via a derived variable). "
                f"The {offending_field} price is only knowable after the bar ends — trading on it "
                "within the same tick assumes you can execute at a price you could not yet observe."
            ),
            "line": if_node.lineno,
            "fix": "Use `bar[\"open\"]` for entry/exit decisions; reserve close/high/low for end-of-bar state updates only.",
        })
        break  # one diagnostic per strategy is enough
    return diagnostics


def check_current_bar_post_fields(entry_method):
    diagnostics = []
    for node in ast.walk(entry_method):
        if _is_bar_post_field(node):
            field = node.slice.value
            diagnostics.append({
                "code": "LOOKAHEAD_BIAS_FLOW",
                "severity": "error",
                "message": (
                    f"`bar[\"{field}\"]` is not exposed in strict v2. Current-bar high/low/close "
                    "are only knowable after the decision."
                ),
                "line": node.lineno,
                "fix": f"Use `bar[\"prev_{field}\"]` or completed rows from `self.broker.history(...)`.",
            })
            break
    return diagnostics


def check_missing_position_sizing(cls):
    """self.position only assigned 0/1 with no arithmetic using price or risk."""
    diagnostics = []
    position_assignments = []
    has_position = False

    for node in ast.walk(cls):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == "self":
            if node.attr == "position":
                has_position = True
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if (
                    isinstance(target, ast.Attribute)
                    and isinstance(target.value, ast.Name)
                    and target.value.id == "self"
                    and target.attr == "position"
                ):
                    position_assignments.append(node.value)

    if not has_position or not position_assignments:
        return diagnostics

    # All assignments must be bare 0/1 constants for us to flag
    all_flag_values = all(
        isinstance(v, ast.Constant) and v.value in (0, 1, True, False)
        for v in position_assignments
    )
    if not all_flag_values:
        return diagnostics

    # Look for any sizing-ish arithmetic: multiplication/division involving "risk", "equity",
    # "capital", "size", or dividing by a stop/ATR.
    sizing_keywords = ("risk", "equity", "capital", "size", "qty", "quantity", "atr", "stop")
    source = ast.dump(cls).lower()
    if any(k in source for k in sizing_keywords):
        return diagnostics  # probably sized elsewhere

    diagnostics.append({
        "code": "MISSING_POSITION_SIZING",
        "severity": "warning",
        "message": (
            "`self.position` is used as a 0/1 flag with no sizing arithmetic. "
            "The strategy implicitly always bets full equity and ignores per-trade risk."
        ),
        "fix": "Size positions from equity and stop distance (e.g. qty = (equity * risk_pct) / stop_distance).",
    })
    return diagnostics


def _refs_bar(expr):
    """True if expression references `bar` anywhere."""
    for n in ast.walk(expr):
        if isinstance(n, ast.Name) and n.id == "bar":
            return True
    return False


def _bar_tainted_locals(on_tick):
    """Locals in on_tick whose value derives from `bar` (directly or transitively)."""
    tainted = set()
    for node in ast.walk(on_tick):
        if isinstance(node, ast.Assign):
            rhs_uses_bar = _refs_bar(node.value)
            rhs_names = _collect_names_from_expr(node.value)
            if rhs_uses_bar or (tainted & rhs_names):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        tainted.add(target.id)
    return tainted


def _self_attrs_referenced(expr):
    """Return set of `self.X` attribute names that `expr` reads."""
    names = set()
    for n in ast.walk(expr):
        if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "self":
            names.add(n.attr)
    return names


def _local_names_tainted_by_self(on_tick, self_attrs_to_track):
    """For each local var in on_tick, determine if its value derives from one of the tracked self.X."""
    tainted = {}  # local_name -> set of tainting self.X
    for node in ast.walk(on_tick):
        if isinstance(node, ast.Assign):
            referenced = _self_attrs_referenced(node.value) & self_attrs_to_track
            rhs_names = _collect_names_from_expr(node.value)
            for t in rhs_names:
                if t in tainted:
                    referenced = referenced | tainted[t]
            if referenced:
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        tainted[target.id] = referenced
    return tainted


def _appends_in_early_return_guards(entry_method, tracked_attrs):
    """Return line numbers of appends inside top-level if-blocks that return,
    making the append unreachable for code after the if-block."""
    guarded = set()
    for stmt in entry_method.body:
        if not isinstance(stmt, ast.If):
            continue
        for branch in (stmt.body, stmt.orelse):
            if not branch:
                continue
            if not any(isinstance(s, ast.Return) for s in branch):
                continue
            for s in branch:
                for n in ast.walk(s):
                    if (
                        isinstance(n, ast.Call)
                        and isinstance(n.func, ast.Attribute)
                        and n.func.attr in GROWTH_METHODS
                        and isinstance(n.func.value, ast.Attribute)
                        and isinstance(n.func.value.value, ast.Name)
                        and n.func.value.value.id == "self"
                        and n.func.value.attr in tracked_attrs
                    ):
                        guarded.add(n.lineno)
    return guarded


def check_same_bar_execution_bias(entry_method):
    """self.X.append(bar-derived) precedes a trade action (return-string OR broker call)
    gated by a condition that compares a bar-tainted local against a self.X-tainted expression."""
    diagnostics = []

    bar_locals = _bar_tainted_locals(entry_method)

    def arg_is_bar_derived(arg):
        if _refs_bar(arg):
            return True
        names = _collect_names_from_expr(arg)
        return bool(names & bar_locals)

    append_events = []  # [(lineno, attr)]
    for node in ast.walk(entry_method):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in GROWTH_METHODS
            and isinstance(node.func.value, ast.Attribute)
            and isinstance(node.func.value.value, ast.Name)
            and node.func.value.value.id == "self"
        ):
            attr = node.func.value.attr
            if any(arg_is_bar_derived(arg) for arg in node.args):
                append_events.append((node.lineno, attr))

    if not append_events:
        return diagnostics

    # Exclude appends inside top-level if-return guards (early returns).
    # These appends can't flow to trade actions after the guard block.
    guarded_lines = _appends_in_early_return_guards(
        entry_method, {attr for _, attr in append_events}
    )
    append_events = [(ln, attr) for ln, attr in append_events
                     if ln not in guarded_lines]
    if not append_events:
        return diagnostics

    tracked = {attr for _, attr in append_events}
    local_taint = _local_names_tainted_by_self(entry_method, tracked)

    # Trade actions: unified across return-strings and broker calls.
    trade_tests = []  # [(lineno, test_node)]
    for action_line, if_node, _kind in _collect_trade_actions(entry_method):
        if if_node is None:
            continue
        trade_tests.append((action_line, if_node.test))

    if not trade_tests:
        return diagnostics

    offenders = []
    for append_line, attr in append_events:
        for action_line, test in trade_tests:
            if action_line <= append_line:
                continue
            test_names = _collect_names_from_expr(test)
            test_has_bar_local = bool(test_names & bar_locals)
            test_self_attrs = _self_attrs_referenced(test)
            matching_locals = {n for n in test_names if attr in local_taint.get(n, set())}
            test_self_tainted = (attr in test_self_attrs) or bool(matching_locals)
            if test_has_bar_local and test_self_tainted:
                offenders.append((attr, append_line, action_line))
                break

    if offenders:
        first_attr, first_append, first_action = offenders[0]
        extras = [a for a, _, _ in offenders[1:]]
        extra_txt = f" (also affects: {', '.join(f'self.{a}' for a in extras)})" if extras else ""
        diagnostics.append({
            "code": "SAME_BAR_EXECUTION_BIAS",
            "severity": "error",
            "message": (
                f"`self.{first_attr}` is updated with current-bar data (line {first_append}) before a "
                f"trade action on line {first_action} that depends on `self.{first_attr}`{extra_txt}. "
                "This is same-bar lookahead: the indicator includes the very tick you're trying to act on."
            ),
            "line": first_action,
            "fix": (
                "Make the trade decision from prior-bar state first, THEN append the current bar's values. "
                "Or store the signal and execute on the next tick."
            ),
        })
    return diagnostics


EQUITY_NAME_HINTS = ("equity", "capital", "balance", "cash", "account_value")


def _is_equity_like(attr_name):
    lowered = attr_name.lower()
    return any(h in lowered for h in EQUITY_NAME_HINTS)


def _uses_broker_api(cls):
    """True if the strategy appears to use the broker-injection pattern."""
    for node in ast.walk(cls):
        if _is_broker_trade_call(node):
            return True
        # `self.broker.equity()`, `self.broker.price(...)` etc.
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Attribute)
            and isinstance(node.value.value, ast.Name)
            and node.value.value.id == "self"
            and node.value.attr == "broker"
        ):
            return True
    return False


def check_equity_never_updated(cls):
    """self.equity (or similar) is read in sizing but never reassigned outside __init__.

    Skipped for broker-API strategies: they should call self.broker.equity() each
    decision (which always reflects current state) rather than maintain their own
    self.equity attribute.
    """
    diagnostics = []

    # Broker-API strategies get equity dynamically — skip.
    if _uses_broker_api(cls):
        return diagnostics

    init = _find_method(cls, "__init__")
    # Check ALL entry methods (on_tick OR on_bar) collectively.
    entry_methods = _find_entry_methods(cls)
    if not entry_methods:
        return diagnostics

    # Names assigned in __init__ at self.*
    init_assigned = set()
    if init is not None:
        for node in ast.walk(init):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if (
                        isinstance(target, ast.Attribute)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "self"
                    ):
                        init_assigned.add(target.attr)
            if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Attribute):
                if isinstance(node.target.value, ast.Name) and node.target.value.id == "self":
                    init_assigned.add(node.target.attr)

    # Names reassigned / mutated inside any entry method at self.*
    entry_mutated = set()
    sizing_reads = set()
    for entry in entry_methods:
        for node in ast.walk(entry):
            if isinstance(node, (ast.Assign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if (
                        isinstance(target, ast.Attribute)
                        and isinstance(target.value, ast.Name)
                        and target.value.id == "self"
                    ):
                        entry_mutated.add(target.attr)
            if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Mult, ast.Div, ast.FloorDiv)):
                for operand in (node.left, node.right):
                    for a in ast.walk(operand):
                        if (
                            isinstance(a, ast.Attribute)
                            and isinstance(a.value, ast.Name)
                            and a.value.id == "self"
                        ):
                            sizing_reads.add(a.attr)

    for attr in init_assigned:
        if not _is_equity_like(attr):
            continue
        if attr in entry_mutated:
            continue
        if attr not in sizing_reads:
            continue
        diagnostics.append({
            "code": "EQUITY_NEVER_UPDATED",
            "severity": "error",
            "message": (
                f"`self.{attr}` is set once in __init__ and used in position sizing, "
                f"but never reassigned. A risk model whose capital never compounds or draws down is fake."
            ),
            "fix": (
                f"Update `self.{attr}` on every SELL: `self.{attr} += realized_pnl` "
                "(or equivalent) so sizing reflects actual PnL. For broker-API strategies, "
                "call `self.broker.equity()` at decision time instead of maintaining your own."
            ),
        })
        break
    return diagnostics


SIZING_DENOM_HINTS = ("stop", "distance", "atr", "risk_per", "range")


def _looks_like_sizing_division(assign):
    """True if RHS is a division whose denominator name hints at stop/risk distance."""
    if not isinstance(assign, ast.Assign):
        return False
    value = assign.value
    if not (isinstance(value, ast.BinOp) and isinstance(value.op, (ast.Div, ast.FloorDiv))):
        return False
    denom_names = _collect_names_from_expr(value.right) | {
        a.attr for a in ast.walk(value.right)
        if isinstance(a, ast.Attribute) and isinstance(a.value, ast.Name) and a.value.id == "self"
    }
    return any(any(h in n.lower() for h in SIZING_DENOM_HINTS) for n in denom_names)


def check_position_size_uncapped(on_tick):
    """qty = risk / stop without a subsequent cap against equity/price."""
    diagnostics = []

    # Find sizing divisions and their target names
    sizing_targets = []  # [(lineno, name)]
    for node in ast.walk(on_tick):
        if not _looks_like_sizing_division(node):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                sizing_targets.append((node.lineno, target.id))
            elif (
                isinstance(target, ast.Attribute)
                and isinstance(target.value, ast.Name)
                and target.value.id == "self"
            ):
                sizing_targets.append((node.lineno, target.attr))

    if not sizing_targets:
        return diagnostics

    # Look for a cap: min(name, X), a later `if name * price > self.equity` guard,
    # or any reference to name INSIDE a call to `min`.
    dumped = ast.dump(on_tick)
    capped_names = set()
    for node in ast.walk(on_tick):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "min":
            for arg in node.args:
                names = _collect_names_from_expr(arg)
                for _, sizing_name in sizing_targets:
                    if sizing_name in names:
                        capped_names.add(sizing_name)
        if isinstance(node, ast.Compare):
            names = _collect_names_from_expr(node.left) | set().union(
                *[_collect_names_from_expr(c) for c in node.comparators]
            )
            # if this compare also mentions equity/capital, treat it as a cap
            all_equity = any(
                _is_equity_like(a.attr)
                for n in [node.left, *node.comparators]
                for a in ast.walk(n)
                if isinstance(a, ast.Attribute) and isinstance(a.value, ast.Name) and a.value.id == "self"
            )
            if all_equity:
                for _, sizing_name in sizing_targets:
                    if sizing_name in names:
                        capped_names.add(sizing_name)

    for lineno, sizing_name in sizing_targets:
        if sizing_name in capped_names:
            continue
        diagnostics.append({
            "code": "POSITION_SIZE_UNCAPPED",
            "severity": "error",
            "message": (
                f"`{sizing_name}` is sized from risk/stop-distance but never capped against available capital. "
                "A single wide stop can push size beyond your equity, creating implicit leverage."
            ),
            "line": lineno,
            "fix": (
                f"Cap with `{sizing_name} = min({sizing_name}, self.equity / price)` "
                "(or `self.broker.equity() / price` for broker-API strategies) before opening the position."
            ),
        })
        break  # one diagnostic is enough
    return diagnostics


EQUITY_TICKER_RE = None  # computed lazily
CRYPTO_SUFFIXES = ("USDT", "USDC", "BUSD", "DAI", "-USD", "/USD", "/USDT")


def _symbol_is_equity(symbol):
    """Heuristic: plain 1-5 uppercase alnum ticker with no crypto suffix → equity."""
    if not symbol or not isinstance(symbol, str):
        return False
    s = symbol.strip().upper()
    if any(suf in s for suf in CRYPTO_SUFFIXES):
        return False
    if "/" in s or "-" in s:
        return False
    if not (1 <= len(s) <= 5):
        return False
    return s.isalnum()


def check_fractional_shares_equity(on_tick, symbol):
    """Equity symbol + float qty from division (no int/floor) → warn."""
    diagnostics = []
    if not _symbol_is_equity(symbol):
        return diagnostics

    for node in ast.walk(on_tick):
        if not _looks_like_sizing_division(node):
            continue
        value = node.value
        # Check for int() / math.floor() / // anywhere in the RHS
        floored = isinstance(value.op, ast.FloorDiv)
        for inner in ast.walk(value):
            if isinstance(inner, ast.Call):
                if isinstance(inner.func, ast.Name) and inner.func.id == "int":
                    floored = True
                if isinstance(inner.func, ast.Attribute) and inner.func.attr == "floor":
                    floored = True
        if floored:
            continue
        diagnostics.append({
            "code": "FRACTIONAL_SHARES_EQUITY",
            "severity": "warning",
            "message": (
                f"Symbol `{symbol}` looks like an equity ticker, but position size is a float. "
                "Most brokers require whole-share orders for stocks/ETFs."
            ),
            "line": node.lineno,
            "fix": "Floor to an integer: `qty = math.floor(qty)` (after capping against capital).",
        })
        break
    return diagnostics


RSI_DENOM_HINTS = ("avg_loss", "avg_gain", "loss_avg", "gain_avg", "denom")


def _is_rsi_denom(node):
    if isinstance(node, ast.Name) and any(h in node.id.lower() for h in RSI_DENOM_HINTS):
        return True
    if isinstance(node, ast.Attribute) and any(h in node.attr.lower() for h in RSI_DENOM_HINTS):
        return True
    return False


def _zero_guard_only(test, denom_name):
    """True if the test is only checking `denom != 0`, `denom > 0`, or bare `denom`."""
    # Compare of form `denom != 0` or `denom > 0`
    if isinstance(test, ast.Compare) and len(test.comparators) == 1:
        left_is_denom = _matches_name(test.left, denom_name)
        right = test.comparators[0]
        right_is_zero = isinstance(right, ast.Constant) and right.value == 0
        if left_is_denom and right_is_zero and isinstance(test.ops[0], (ast.NotEq, ast.Gt)):
            return True
    # Bare `denom` (truthiness check)
    if _matches_name(test, denom_name):
        return True
    return False


def _matches_name(node, name):
    if isinstance(node, ast.Name) and node.id == name:
        return True
    if isinstance(node, ast.Attribute) and node.attr == name:
        return True
    return False


def _body_divides_by(body_nodes, denom_name):
    """True if any statement in body_nodes contains `x / denom_name`."""
    for body_stmt in body_nodes:
        for sub in ast.walk(body_stmt):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.Div):
                if _matches_name(sub.right, denom_name):
                    return sub.lineno
    return None


def _expr_divides_by(expr, denom_name):
    """True if expression `expr` contains `x / denom_name` anywhere."""
    for sub in ast.walk(expr):
        if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.Div):
            if _matches_name(sub.right, denom_name):
                return sub.lineno
    return None


def check_near_zero_division(on_tick):
    """RSI-shaped division guarded only by `denom != 0` or `denom > 0` (literal zero).

    Handles both `if denom != 0: ... / denom ...` and the inline form
    `x / denom if denom != 0 else fallback`.
    """
    diagnostics = []

    def try_report(test, body_or_expr, fallback_line, is_expr):
        # Find candidate denom names from the test
        candidate_denoms = set()
        for sub in ast.walk(test):
            if _is_rsi_denom(sub):
                if isinstance(sub, ast.Name):
                    candidate_denoms.add(sub.id)
                elif isinstance(sub, ast.Attribute):
                    candidate_denoms.add(sub.attr)
        if not candidate_denoms:
            return None
        for denom_name in candidate_denoms:
            if not _zero_guard_only(test, denom_name):
                continue
            if is_expr:
                line = _expr_divides_by(body_or_expr, denom_name)
            else:
                line = _body_divides_by(body_or_expr, denom_name)
            if line is not None:
                return {
                    "code": "NEAR_ZERO_DIVISION",
                    "severity": "warning",
                    "message": (
                        f"`{denom_name}` is guarded only by `!= 0` / `> 0`, but very small values "
                        "still produce unstable ratios (e.g. RSI spikes to 99.9 on near-zero avg_loss). "
                        "Use an epsilon guard."
                    ),
                    "line": line,
                    "fix": f"Change the guard to `{denom_name} > 1e-10` (or similar epsilon).",
                }
        return None

    for node in ast.walk(on_tick):
        # Classic: if denom != 0: ... denom ...
        if isinstance(node, ast.If):
            found = try_report(node.test, node.body, node.lineno, is_expr=False)
            if found:
                diagnostics.append(found)
                return diagnostics
        # Inline: x / denom if denom != 0 else fallback
        if isinstance(node, ast.IfExp):
            found = try_report(node.test, node.body, node.lineno, is_expr=True)
            if found:
                diagnostics.append(found)
                return diagnostics
    return diagnostics


def analyze(code, symbol=None):
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []

    cls = _find_class(tree, "Strategy")
    if cls is None:
        return []

    diagnostics = []
    diagnostics += check_rms_not_stddev(tree)
    diagnostics += check_population_variance(tree)
    diagnostics += check_strict_security(tree, cls)
    diagnostics += check_gains_losses_asymmetry(cls)
    diagnostics += check_missing_position_sizing(cls)
    diagnostics += check_equity_never_updated(cls)

    # Run entry-method-scoped checks for every entry method the strategy defines.
    # This covers both legacy on_tick strategies and broker-API on_bar strategies.
    entry_methods = _find_entry_methods(cls)
    emitted_codes = {d["code"] for d in diagnostics}
    for entry in entry_methods:
        for check_fn, *args in (
            (check_state_reset_in_on_tick, entry),
            (check_current_bar_post_fields, entry),
            (check_lookahead_bias_flow, entry),
            (check_same_bar_execution_bias, entry),
            (check_position_size_uncapped, entry),
            (check_near_zero_division, entry),
            (check_fractional_shares_equity, entry, symbol),
        ):
            for d in check_fn(*args):
                # Dedupe across multiple entry methods — emit each diagnostic code once.
                if d["code"] in emitted_codes:
                    continue
                emitted_codes.add(d["code"])
                diagnostics.append(d)

    return diagnostics


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None, help="Symbol from config.json (informs FRACTIONAL_SHARES_EQUITY).")
    args = parser.parse_args()

    code = sys.stdin.read()
    try:
        diagnostics = analyze(code, symbol=args.symbol)
    except Exception as exc:  # defensive: never crash the parent process
        sys.stderr.write(f"ast_analyzer error: {exc}\n")
        sys.stdout.write("[]")
        sys.exit(0)
    sys.stdout.write(json.dumps(diagnostics))


if __name__ == "__main__":
    main()
