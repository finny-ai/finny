// Keep Robinhood's live Python adapter separate from the already-large shared broker declaration.
export const ROBINHOOD_BROKER_PY = String.raw`
import re
import subprocess
import time
import urllib.parse
import urllib.request
class RobinhoodBroker(Broker):
    """Robinhood adapter backed by the rhx CLI.

    rhx owns credentials, MFA, sessions, its live unlock, and API transport.
    Finny only supplies a profile name and consumes the versioned JSON output.
    Historical bars come from yfinance because neither rhx nor Robinhood's
    official Crypto Trading API exposes a candle endpoint.
    """

    CRYPTO_BASES = {
        "BTC", "ETH", "SOL", "DOGE", "AVAX", "MATIC", "LINK", "DOT",
        "ADA", "XRP", "LTC", "BCH", "UNI", "AAVE", "SHIB",
    }
    _SYMBOL_RE = re.compile(r"^[A-Z0-9]{1,10}(?:-USD)?$")
    _SEARCH_MAX_DEPTH, _SEARCH_MAX_NODES = 8, 1024

    def __init__(self, profile: str = "default", command: str = "rhx", symbol: Optional[str] = None):
        self._profile = profile.strip() or "default"
        self._command = command.strip()
        if not self._command:
            raise RuntimeError("Robinhood rhx executable is empty")
        self._active_symbol = self.normalize_symbol(symbol or "AAPL")
        self._last_price: Dict[str, float] = {}
        self._instrument_symbols: Dict[str, str] = {}

    @staticmethod
    def is_crypto(symbol: str) -> bool:
        normalized = str(symbol or "").upper().strip().replace("/", "-")
        if "-" in normalized:
            parts = normalized.split("-")
            return len(parts) == 2 and bool(parts[0]) and parts[1] == "USD"
        if normalized.endswith("USD") and len(normalized) > 3:
            return True
        return normalized in RobinhoodBroker.CRYPTO_BASES

    @staticmethod
    def normalize_symbol(symbol: str) -> str:
        normalized = str(symbol or "").upper().strip().replace("/", "-")
        if not RobinhoodBroker.is_crypto(normalized):
            return normalized
        if "-" in normalized:
            return normalized
        if normalized.endswith("USD") and len(normalized) > 3:
            return f"{normalized[:-3]}-USD"
        return f"{normalized}-USD"

    @staticmethod
    def _number(value) -> Optional[float]:
        try:
            parsed = float(value)
            return parsed if math.isfinite(parsed) else None
        except (TypeError, ValueError):
            return None

    @classmethod
    def _containers(cls, value):
        stack = [(value, 0)]
        visited = 0
        while stack:
            current, depth = stack.pop()
            visited += 1
            if visited > cls._SEARCH_MAX_NODES:
                raise RuntimeError("rhx payload exceeds the supported size")
            if isinstance(current, dict):
                yield current
                children = list(current.values())
            elif isinstance(current, list):
                children = current
            else:
                continue
            nested = [child for child in children if isinstance(child, (dict, list))]
            if nested and depth >= cls._SEARCH_MAX_DEPTH:
                raise RuntimeError("rhx payload exceeds the supported nesting depth")
            for child in reversed(nested):
                stack.append((child, depth + 1))

    @classmethod
    def _find_number(cls, value, *keys: str) -> Optional[float]:
        for row in cls._containers(value):
            for key in keys:
                if key in row:
                    parsed = cls._number(row[key])
                    if parsed is not None:
                        return parsed
        return None

    @classmethod
    def _find_string(cls, value, *keys: str) -> Optional[str]:
        for row in cls._containers(value):
            for key in keys:
                item = row.get(key)
                if isinstance(item, str) and item.strip():
                    return item.strip()
        return None

    @staticmethod
    def _rows(value) -> list:
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
        if isinstance(value, dict):
            results = value.get("results")
            if isinstance(results, list):
                return [row for row in results if isinstance(row, dict)]
        return []

    def _run(self, args: list, provider: Optional[str] = None):
        # This release is shadow-only. Keep the strategy worker's RHX surface
        # structurally read-only even if strategy reflection reaches this adapter.
        allowed = (
            len(args) == 2 and args[0] == "account" and args[1] == "summary"
        ) or (
            len(args) == 2 and args[0] == "positions" and args[1] == "list"
        ) or (
            len(args) == 3
            and args[0] == "quote"
            and args[1] == "get"
            and isinstance(args[2], str)
            and bool(self._SYMBOL_RE.fullmatch(args[2]))
        )
        if not allowed:
            raise RuntimeError("Robinhood RHX command is not available in the shadow-only strategy worker")
        command = [self._command, "--json", "--profile", self._profile]
        if provider:
            command.extend(["--provider", provider])
        command.extend(args)
        try:
            completed = subprocess.run(command, capture_output=True, text=True, timeout=30, check=False)
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"rhx executable not found: {self._command!r}. Install rhx and authenticate the configured profile."
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("rhx command timed out after 30 seconds") from exc

        envelope = None
        for output in (completed.stdout, completed.stderr):
            for line in reversed(output.splitlines()):
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict) and "ok" in parsed:
                    envelope = parsed
                    break
            if envelope is not None:
                break
        if envelope is None:
            raise RuntimeError(f"rhx returned no JSON envelope (exit {completed.returncode})")
        schema = (envelope.get("meta") or {}).get("output_schema")
        if schema != "v4":
            raise RuntimeError(f"Unsupported rhx JSON schema {schema!r}; Finny requires v4")
        if not envelope.get("ok") or completed.returncode != 0:
            error = envelope.get("error")
            code = error.get("code") if isinstance(error, dict) else "RHX_ERROR"
            if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,64}", code):
                code = "RHX_ERROR"
            raise RuntimeError(f"{code}: rhx command failed")
        return envelope.get("data")

    def _provider(self, symbol: Optional[str] = None) -> str:
        return "crypto" if self.is_crypto(symbol or self._active_symbol) else "brokerage"

    @classmethod
    def _quote_row(cls, data, symbol: str):
        if not isinstance(data, dict):
            raise RuntimeError(f"rhx returned an invalid quote payload for {symbol}")
        wrapped_symbol = data.get("symbol")
        if isinstance(wrapped_symbol, str) and cls.normalize_symbol(wrapped_symbol) != symbol:
            raise RuntimeError(f"rhx returned a quote for an unexpected symbol instead of {symbol}")

        quote = data.get("quote")
        root = quote if isinstance(quote, (dict, list)) else data
        if isinstance(root, list):
            results = root
        elif isinstance(root, dict) and "results" in root:
            results = root["results"]
        elif isinstance(root, dict):
            return root
        else:
            raise RuntimeError(f"rhx returned an invalid quote payload for {symbol}")
        if not isinstance(results, list):
            raise RuntimeError(f"rhx returned invalid quote results for {symbol}")

        rows = [row for row in results if isinstance(row, dict)]
        matches = [
            row for row in rows
            if isinstance(row.get("symbol"), str) and cls.normalize_symbol(row["symbol"]) == symbol
        ]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise RuntimeError(f"rhx returned duplicate quote results for {symbol}")
        if len(rows) == 1 and (wrapped_symbol is None or cls.normalize_symbol(str(wrapped_symbol)) == symbol):
            return rows[0]
        raise RuntimeError(f"rhx returned no unambiguous quote result for {symbol}")

    @classmethod
    def _quote_number(cls, row, *keys: str) -> Optional[float]:
        if isinstance(row, dict):
            for key in keys:
                if key in row:
                    parsed = cls._number(row[key])
                    if parsed is not None:
                        return parsed
        return cls._find_number(row, *keys)

    def _quote(self, symbol: str, provider: Optional[str] = None) -> Dict[str, float]:
        normalized = self.normalize_symbol(symbol)
        selected = provider or self._provider(normalized)
        data = self._run(["quote", "get", normalized], provider=selected)
        row = self._quote_row(data, normalized)
        if selected == "crypto":
            bid = self._quote_number(row, "bid_inclusive_of_sell_spread", "bid_price", "bid")
            ask = self._quote_number(row, "ask_inclusive_of_buy_spread", "ask_price", "ask")
        else:
            bid = self._quote_number(row, "bid_price", "bid")
            ask = self._quote_number(row, "ask_price", "ask")
        last = self._quote_number(row, "last_trade_price", "mark_price", "price", "mark")
        if last is None and bid is not None and ask is not None:
            last = (bid + ask) / 2.0
        if last is None:
            last = ask if ask is not None else bid
        if last is None or last <= 0:
            raise RuntimeError(f"rhx returned no usable price for {normalized}")
        instrument = self._find_string(row, "instrument")
        if instrument:
            canonical = self._validated_instrument_url(instrument)
            self._instrument_symbols.update({instrument: normalized, canonical: normalized})
        self._last_price[normalized] = float(last)
        return {"bid": float(bid or last), "ask": float(ask or last), "last": float(last)}

    @staticmethod
    def _validated_instrument_url(instrument: str) -> str:
        parsed = urllib.parse.urlparse(instrument)
        parts = [part for part in parsed.path.split("/") if part]
        valid_id = len(parts) == 2 and parts[0] == "instruments" and all(
            char.isalnum() or char == "-" for char in parts[1]
        )
        if (
            parsed.scheme != "https"
            or parsed.netloc != "api.robinhood.com"
            or parsed.params
            or parsed.query
            or parsed.fragment
            or not valid_id
        ):
            raise RuntimeError("rhx returned an invalid Robinhood instrument URL")
        return f"https://api.robinhood.com/{parts[0]}/{parts[1]}/"

    def _resolve_instrument_symbol(self, instrument: str) -> str:
        url = self._validated_instrument_url(instrument)
        cached = self._instrument_symbols.get(instrument) or self._instrument_symbols.get(url)
        if cached:
            return cached
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "Finny/Robinhood"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
        except Exception as exc:
            raise RuntimeError("Unable to resolve a Robinhood stock instrument") from exc
        raw = payload.get("symbol") if isinstance(payload, dict) else None
        if not isinstance(raw, str) or not raw.strip():
            raise RuntimeError("Robinhood instrument response omitted its symbol")
        symbol = self.normalize_symbol(raw)
        self._instrument_symbols.update({instrument: symbol, url: symbol})
        return symbol

    def _row_symbol(self, row: Dict[str, Any]) -> Optional[str]:
        asset_type = str(row.get("asset_type") or "").lower()
        if asset_type == "option":
            return None
        raw = self._find_string(row, "symbol")
        if raw:
            return self.normalize_symbol(raw)
        base = self._find_string(row, "asset_code", "code")
        if base and asset_type == "crypto":
            return self.normalize_symbol(base)
        instrument = self._find_string(row, "instrument")
        if instrument:
            return self._resolve_instrument_symbol(instrument)
        return None

    @classmethod
    def _row_quantity(cls, row: Dict[str, Any]) -> float:
        return float(cls._find_number(row, "total_quantity", "quantity", "quantity_available_for_trading") or 0)

    def _snapshot_price(self, symbol: str, provider: str, resolved: set) -> float:
        normalized = self.normalize_symbol(symbol)
        if normalized in resolved:
            cached = self._last_price.get(normalized)
            if cached is None:
                raise RuntimeError(f"rhx quote cache is missing {normalized}")
            return cached
        price = self._quote(normalized, provider=provider)["last"]
        resolved.add(normalized)
        return price

    def _account_values(
        self,
        summary=None,
        rows: Optional[list] = None,
        provider: Optional[str] = None,
        resolved: Optional[set] = None,
    ) -> Tuple[float, float]:
        provider = provider or self._provider()
        data = summary if summary is not None else self._run(["account", "summary"], provider=provider)
        if provider == "crypto":
            cash = self._number(data.get("buying_power")) if isinstance(data, dict) else None
            if cash is None:
                cash = self._find_number(data, "buying_power")
            if cash is None:
                raise RuntimeError("rhx crypto account response omitted buying_power")
            equity = float(cash)
            positions = rows if rows is not None else self._rows(self._run(["positions", "list"], provider="crypto"))
            refreshed = resolved if resolved is not None else set()
            for row in positions:
                qty = self._row_quantity(row)
                if qty == 0:
                    continue
                symbol = self._row_symbol({**row, "asset_type": "crypto"})
                if not symbol:
                    raise RuntimeError("rhx returned a crypto holding without an asset code")
                equity += qty * self._snapshot_price(symbol, "crypto", refreshed)
            return float(cash), float(equity)

        account = data.get("account_profile") if isinstance(data, dict) else None
        portfolio = data.get("portfolio_profile") if isinstance(data, dict) else None
        cash = self._number(account.get("cash")) if isinstance(account, dict) else None
        if cash is None:
            cash = self._find_number(data, "cash", "buying_power")
        equity = None
        if isinstance(portfolio, dict):
            for key in ("equity", "portfolio_value", "extended_hours_equity"):
                equity = self._number(portfolio.get(key))
                if equity is not None:
                    break
        if equity is None:
            equity = self._find_number(data, "equity", "portfolio_value", "extended_hours_equity")
        if cash is None or equity is None:
            raise RuntimeError("rhx brokerage account response omitted cash or equity")
        return float(cash), float(equity)

    def market_is_open(self, symbol: str) -> bool:
        if self.is_crypto(symbol):
            return True
        try:
            import yfinance as yf  # type: ignore
            metadata = yf.Ticker(self.normalize_symbol(symbol)).get_history_metadata()
            regular = ((metadata or {}).get("currentTradingPeriod") or {}).get("regular") or {}
            start = float(regular.get("start"))
            end = float(regular.get("end"))
            return start <= time.time() <= end
        except Exception as exc:
            log_err(f"Robinhood market calendar error: {exc}")
            return False

    def set_price(self, symbol: str, price: float) -> None:
        self._last_price[self.normalize_symbol(symbol)] = float(price)

    def price(self, symbol: str) -> Optional[float]:
        normalized = self.normalize_symbol(symbol)
        cached = self._last_price.get(normalized)
        if cached is not None:
            return cached
        try:
            return self._quote(normalized)["last"]
        except Exception:
            return None

    def position(self, symbol: str) -> float:
        normalized = self.normalize_symbol(symbol)
        provider = self._provider(normalized)
        if provider == "brokerage":
            # RHX forwards Robinhood's stock position rows with an instrument
            # URL rather than a symbol. The quote payload contains the same URL,
            # allowing a fail-closed mapping without another unofficial API.
            self._quote(normalized, provider=provider)
        rows = self._rows(self._run(["positions", "list"], provider=provider))
        for row in rows:
            typed = {**row, "asset_type": row.get("asset_type") or ("crypto" if provider == "crypto" else "stock")}
            if self._row_symbol(typed) == normalized:
                return self._row_quantity(row)
        return 0.0

    def cash(self) -> float:
        return self._account_values()[0]

    def equity(self) -> float:
        return self._account_values()[1]

    def execution_snapshot(self, symbol: str) -> Dict[str, Any]:
        self._active_symbol = self.normalize_symbol(symbol)
        provider = self._provider()
        resolved = set()
        if provider == "brokerage":
            self._snapshot_price(self._active_symbol, provider, resolved)
        summary = self._run(["account", "summary"], provider=provider)
        rows = self._rows(self._run(["positions", "list"], provider=provider))
        cash, equity = self._account_values(summary, rows, provider, resolved)
        positions: Dict[str, Dict[str, float]] = {}
        for row in rows:
            qty = self._row_quantity(row)
            if qty == 0:
                continue
            asset_type = str(row.get("asset_type") or ("crypto" if provider == "crypto" else "stock")).lower()
            if asset_type == "option":
                raise RuntimeError("Robinhood execution snapshots do not support open option positions")
            typed = {**row, "asset_type": asset_type}
            position_symbol = self._row_symbol(typed)
            if not position_symbol:
                raise RuntimeError("rhx returned a nonzero position without a symbol")
            quote_provider = "crypto" if asset_type == "crypto" and provider == "crypto" else "brokerage"
            mark = self._snapshot_price(position_symbol, quote_provider, resolved)
            positions[position_symbol] = {"qty": qty, "mark": mark}
        return {"cash": cash, "equity": equity, "positions": positions}

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None):
        return self._submit(symbol, "buy", qty, notional, reason=reason, features=features)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None):
        return self._submit(symbol, "sell", qty, notional, reason=reason, features=features)

    def _submit(self, symbol, side, qty, notional, reason=None, features=None):
        normalized = self.normalize_symbol(symbol)
        return self._reject(
            normalized,
            side,
            "Robinhood order submission is disabled in this shadow-only Finny release",
            reason=reason,
            features=features,
        )

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        try:
            import yfinance as yf  # type: ignore
        except ImportError as exc:
            log_err(f"yfinance missing for Robinhood fetch_bar: {exc}")
            return None

        normalized = self.normalize_symbol(symbol)
        yf_interval = {
            "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m",
            "1h": "60m", "4h": "60m", "1d": "1d",
        }.get(interval, "1m")
        period = {
            "1min": "1d", "5min": "5d", "15min": "5d", "30min": "5d",
            "1h": "1mo", "4h": "1mo", "1d": "3mo",
        }.get(interval, "1d")
        try:
            frame = yf.Ticker(normalized).history(period=period, interval=yf_interval, auto_adjust=False, prepost=False)
            if frame is None or frame.empty:
                return None
            if interval == "4h":
                frame = frame.resample("4h").agg({
                    "Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum",
                }).dropna(subset=["Open", "High", "Low", "Close"])
            candidates = list(frame.iterrows())
            latest, finality = newest_finalized_bar(candidates, interval, lambda item: item[0].to_pydatetime())
            if latest is None:
                return None
            timestamp, row = latest
            ts = timestamp.to_pydatetime()
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            else:
                ts = ts.astimezone(timezone.utc)
            return {
                "timestamp": ts.isoformat(),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row.get("Volume", 0)),
                **finality,
            }
        except Exception as exc:
            log_err(f"Robinhood yfinance fetch_bar error: {exc}")
            return None

    def _reject(self, symbol, side, reject_reason, reason=None, features=None):
        return OrderRecord(
            order_id="rejected",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reject_reason}",
            ts=datetime.now(timezone.utc).isoformat(),
            reason=reason,
            features=features,
        )
`
