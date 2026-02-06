#!/usr/bin/env python3
"""
AST-based Strategy Validator for Finny

Validates Python trading strategies for:
- Syntax errors (with line numbers)
- Required structure (class Strategy, def on_tick)
- Lookahead bias (bar['close'] usage warnings)
- Forbidden imports (os, subprocess, sys, socket)
- Dangerous functions (exec, eval, compile)
"""

import ast
import sys
import argparse
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class ValidationResult:
    valid: bool
    errors: List[str]
    warnings: List[str]

    def to_dict(self) -> dict:
        return {
            "valid": self.valid,
            "errors": self.errors,
            "warnings": self.warnings
        }


# Forbidden imports - security risk
FORBIDDEN_IMPORTS = {
    "os", "subprocess", "sys", "socket", "requests", "urllib",
    "http", "ftplib", "telnetlib", "smtplib", "poplib", "imaplib",
    "nntplib", "pickle", "shelve", "marshal", "dbm", "sqlite3",
    "ctypes", "multiprocessing", "threading", "asyncio", "concurrent"
}

# Allowed imports for strategies
ALLOWED_IMPORTS = {
    "math", "statistics", "collections", "dataclasses", "typing",
    "decimal", "fractions", "random", "itertools", "functools",
    "operator", "copy", "enum", "datetime", "time"
}

# Dangerous function calls
DANGEROUS_FUNCTIONS = {
    "exec", "eval", "compile", "open", "input", "__import__",
    "getattr", "setattr", "delattr", "globals", "locals",
    "breakpoint", "exit", "quit"
}


class StrategyValidator(ast.NodeVisitor):
    """AST visitor that validates strategy code."""

    def __init__(self, source_code: str):
        self.source_code = source_code
        self.source_lines = source_code.split('\n')
        self.errors: List[str] = []
        self.warnings: List[str] = []
        self.has_strategy_class = False
        self.has_init_method = False
        self.has_on_tick_method = False
        self.current_class: Optional[str] = None

    def validate(self) -> ValidationResult:
        """Run validation and return results."""
        try:
            tree = ast.parse(self.source_code)
        except SyntaxError as e:
            return ValidationResult(
                valid=False,
                errors=[f"Syntax error at line {e.lineno}: {e.msg}"],
                warnings=[]
            )

        # Visit the AST
        self.visit(tree)

        # Check required structure
        if not self.has_strategy_class:
            self.errors.append("Missing required 'Strategy' class")
        if not self.has_init_method:
            self.errors.append("Strategy class missing '__init__' method")
        if not self.has_on_tick_method:
            self.errors.append("Strategy class missing 'on_tick' method")

        return ValidationResult(
            valid=len(self.errors) == 0,
            errors=self.errors,
            warnings=self.warnings
        )

    def visit_Import(self, node: ast.Import):
        """Check import statements."""
        for alias in node.names:
            module_name = alias.name.split('.')[0]
            if module_name in FORBIDDEN_IMPORTS:
                self.errors.append(
                    f"Line {node.lineno}: Forbidden import '{alias.name}'"
                )
            elif module_name not in ALLOWED_IMPORTS:
                self.warnings.append(
                    f"Line {node.lineno}: Unknown import '{alias.name}' - may not work in sandbox"
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):
        """Check from ... import statements."""
        if node.module:
            module_name = node.module.split('.')[0]
            if module_name in FORBIDDEN_IMPORTS:
                self.errors.append(
                    f"Line {node.lineno}: Forbidden import from '{node.module}'"
                )
            elif module_name not in ALLOWED_IMPORTS:
                self.warnings.append(
                    f"Line {node.lineno}: Unknown import from '{node.module}' - may not work in sandbox"
                )
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef):
        """Check class definitions."""
        if node.name == "Strategy":
            self.has_strategy_class = True
            self.current_class = "Strategy"

            # Check for required methods
            for item in node.body:
                if isinstance(item, ast.FunctionDef):
                    if item.name == "__init__":
                        self.has_init_method = True
                        self._check_init_method(item)
                    elif item.name == "on_tick":
                        self.has_on_tick_method = True
                        self._check_on_tick_method(item)

            self.generic_visit(node)
            self.current_class = None
        else:
            self.generic_visit(node)

    def _check_init_method(self, node: ast.FunctionDef):
        """Check __init__ method has self parameter."""
        if len(node.args.args) < 1 or node.args.args[0].arg != "self":
            self.errors.append(
                f"Line {node.lineno}: __init__ must have 'self' as first parameter"
            )

    def _check_on_tick_method(self, node: ast.FunctionDef):
        """Check on_tick method signature."""
        args = node.args.args
        if len(args) < 2:
            self.errors.append(
                f"Line {node.lineno}: on_tick must have 'self' and 'bar' parameters"
            )
        elif args[0].arg != "self":
            self.errors.append(
                f"Line {node.lineno}: on_tick first parameter must be 'self'"
            )
        elif len(args) >= 2 and args[1].arg != "bar":
            self.warnings.append(
                f"Line {node.lineno}: on_tick second parameter should be 'bar' (got '{args[1].arg}')"
            )

        # Check return type annotation if present
        if node.returns:
            if isinstance(node.returns, ast.Constant) and node.returns.value != "str":
                self.warnings.append(
                    f"Line {node.lineno}: on_tick should return str ('BUY', 'SELL', or 'HOLD')"
                )

    def visit_Call(self, node: ast.Call):
        """Check function calls for dangerous functions."""
        func_name = None

        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        if func_name in DANGEROUS_FUNCTIONS:
            self.errors.append(
                f"Line {node.lineno}: Forbidden function call '{func_name}'"
            )

        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript):
        """Check for lookahead bias in bar access."""
        # Check for bar['close'] pattern
        if isinstance(node.value, ast.Name) and node.value.id == "bar":
            if isinstance(node.slice, ast.Constant):
                key = node.slice.value
                if key == "close":
                    # Get the line content to check context
                    line = self.source_lines[node.lineno - 1] if node.lineno <= len(self.source_lines) else ""
                    # Warn unless it's clearly for position exit logic
                    if "return" in line and ("BUY" in line or "position" not in line):
                        self.warnings.append(
                            f"Line {node.lineno}: Potential lookahead bias - using bar['close'] for entry decision. "
                            f"Consider using bar['open'] instead."
                        )

        self.generic_visit(node)


def validate_file(filepath: str) -> ValidationResult:
    """Validate a strategy file."""
    try:
        with open(filepath, 'r') as f:
            source_code = f.read()
    except FileNotFoundError:
        return ValidationResult(
            valid=False,
            errors=[f"File not found: {filepath}"],
            warnings=[]
        )
    except Exception as e:
        return ValidationResult(
            valid=False,
            errors=[f"Error reading file: {e}"],
            warnings=[]
        )

    return validate_code(source_code)


def validate_code(source_code: str) -> ValidationResult:
    """Validate strategy source code."""
    validator = StrategyValidator(source_code)
    return validator.validate()


def main():
    parser = argparse.ArgumentParser(description="Validate trading strategy code")
    parser.add_argument("filepath", help="Path to the strategy file to validate")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    result = validate_file(args.filepath)

    if args.json:
        import json
        print(json.dumps(result.to_dict(), indent=2))
    else:
        if result.valid:
            print(f"VALID: Strategy passed validation")
            if result.warnings:
                print(f"\nWarnings ({len(result.warnings)}):")
                for warning in result.warnings:
                    print(f"  - {warning}")
        else:
            print(f"INVALID: Strategy failed validation")
            print(f"\nErrors ({len(result.errors)}):")
            for error in result.errors:
                print(f"  - {error}")
            if result.warnings:
                print(f"\nWarnings ({len(result.warnings)}):")
                for warning in result.warnings:
                    print(f"  - {warning}")

    sys.exit(0 if result.valid else 1)


if __name__ == "__main__":
    main()
