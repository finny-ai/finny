"""
Data Feed Module for Finny Simulator

Provides market data from multiple sources:
- Stocks: yfinance (free, no API key required)
- Crypto: Binance via ccxt (free public data)
"""

import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from collections import deque

try:
    import yfinance as yf
    YFINANCE_AVAILABLE = True
except ImportError:
    YFINANCE_AVAILABLE = False
    print("Warning: yfinance not installed. Stock data unavailable.")

try:
    import ccxt
    CCXT_AVAILABLE = True
except ImportError:
    CCXT_AVAILABLE = False
    print("Warning: ccxt not installed. Crypto data unavailable.")


class DataFeed:
    """
    Hybrid data feed supporting both stocks and crypto.
    """

    # Supported stock symbols
    STOCK_SYMBOLS = ["AAPL", "PLTR", "NVDA"]

    # Supported crypto symbols (mapped to Coinbase pairs - works in US)
    CRYPTO_SYMBOLS = {
        "BTC": "BTC/USD",
        "ETH": "ETH/USD",
        "SOL": "SOL/USD",
    }

    def __init__(self):
        self.price_cache: Dict[str, dict] = {}
        self.history_cache: Dict[str, deque] = {}
        self.last_fetch_time: Dict[str, float] = {}

        # Initialize yfinance tickers
        if YFINANCE_AVAILABLE:
            self.tickers = yf.Tickers(" ".join(self.STOCK_SYMBOLS))
        else:
            self.tickers = None

        # Initialize Coinbase exchange via ccxt (works in US, unlike Binance)
        if CCXT_AVAILABLE:
            try:
                self.exchange = ccxt.coinbase({
                    'enableRateLimit': True,
                })
                self.exchange.load_markets()
                print("DataFeed: Coinbase connection established")
            except Exception as e:
                print(f"DataFeed: Coinbase unavailable: {e}")
                self.exchange = None
        else:
            self.exchange = None

        # Initialize history caches
        for symbol in self.STOCK_SYMBOLS + list(self.CRYPTO_SYMBOLS.keys()):
            self.history_cache[symbol] = deque(maxlen=200)

    @property
    def symbols(self) -> List[str]:
        """Return all available symbols."""
        return self.STOCK_SYMBOLS + list(self.CRYPTO_SYMBOLS.keys())

    def is_crypto(self, symbol: str) -> bool:
        """Check if symbol is a cryptocurrency."""
        return symbol in self.CRYPTO_SYMBOLS

    def is_stock(self, symbol: str) -> bool:
        """Check if symbol is a stock."""
        return symbol in self.STOCK_SYMBOLS

    def get_price(self, symbol: str) -> Optional[dict]:
        """
        Get current price data for a symbol.

        Returns:
            dict with keys: symbol, open, high, low, close, volume, timestamp
            or None if unavailable
        """
        if self.is_crypto(symbol):
            return self._get_crypto_price(symbol)
        elif self.is_stock(symbol):
            return self._get_stock_price(symbol)
        return None

    def _get_stock_price(self, symbol: str) -> Optional[dict]:
        """Fetch stock price from yfinance."""
        if not YFINANCE_AVAILABLE or self.tickers is None:
            return self.price_cache.get(symbol)

        try:
            ticker = self.tickers.tickers[symbol]
            price = None
            volume = 0
            extra_data = {}

            # Primary: use fast_info (more reliable, fewer API issues)
            try:
                fast = ticker.fast_info
                price = fast.get('lastPrice') or fast.get('regularMarketPrice')
                volume = fast.get('lastVolume', 0)
                extra_data['marketCap'] = fast.get('marketCap')
                extra_data['fiftyTwoWeekHigh'] = fast.get('fiftyTwoWeekHigh') or fast.get('yearHigh')
                extra_data['fiftyTwoWeekLow'] = fast.get('fiftyTwoWeekLow') or fast.get('yearLow')
                extra_data['previousClose'] = fast.get('previousClose') or fast.get('regularMarketPreviousClose')
            except Exception:
                pass

            # Fallback: try info dict if fast_info failed
            if price is None:
                try:
                    info = ticker.info
                    price = (
                        info.get('currentPrice') or
                        info.get('regularMarketPrice') or
                        info.get('previousClose')
                    )
                    volume = info.get('volume', 0)
                    extra_data['marketCap'] = info.get('marketCap')
                    extra_data['fiftyTwoWeekHigh'] = info.get('fiftyTwoWeekHigh')
                    extra_data['fiftyTwoWeekLow'] = info.get('fiftyTwoWeekLow')
                    extra_data['previousClose'] = info.get('previousClose') or info.get('regularMarketPreviousClose')
                    extra_data['pe'] = info.get('trailingPE') or info.get('forwardPE')
                    extra_data['dayHigh'] = info.get('dayHigh') or info.get('regularMarketDayHigh')
                    extra_data['dayLow'] = info.get('dayLow') or info.get('regularMarketDayLow')
                except Exception:
                    pass

            # If we still have no price, return cached data
            if price is None:
                return self.price_cache.get(symbol)

            timestamp = int(datetime.now().timestamp() * 1000)

            # Use day high/low if available, otherwise estimate from price
            day_high = extra_data.get('dayHigh') or (price * 1.0005)
            day_low = extra_data.get('dayLow') or (price * 0.9995)

            bar = {
                'symbol': symbol,
                'open': float(extra_data.get('previousClose') or price),
                'high': float(day_high),
                'low': float(day_low),
                'close': float(price),
                'volume': float(volume or 0),
                'timestamp': timestamp,
                # Extra stock data
                'marketCap': extra_data.get('marketCap'),
                'fiftyTwoWeekHigh': extra_data.get('fiftyTwoWeekHigh'),
                'fiftyTwoWeekLow': extra_data.get('fiftyTwoWeekLow'),
                'previousClose': extra_data.get('previousClose'),
                'pe': extra_data.get('pe'),
            }

            self.price_cache[symbol] = bar
            self._update_history(symbol, bar)

            return bar

        except Exception:
            # Silently return cached data on errors (market closed, rate limited, etc.)
            return self.price_cache.get(symbol)

    def _get_crypto_price(self, symbol: str) -> Optional[dict]:
        """Fetch crypto price from Coinbase via ccxt."""
        if not CCXT_AVAILABLE or self.exchange is None:
            return self.price_cache.get(symbol)

        pair = self.CRYPTO_SYMBOLS.get(symbol)
        if not pair:
            return self.price_cache.get(symbol)

        try:
            ticker = self.exchange.fetch_ticker(pair)
            timestamp = int(datetime.now().timestamp() * 1000)

            # Use last price as fallback when open/high/low are None
            last_price = float(ticker['last'])
            spread = last_price * 0.0005  # 0.05% spread estimate

            bar = {
                'symbol': symbol,
                'open': float(ticker['open']) if ticker.get('open') is not None else last_price,
                'high': float(ticker['high']) if ticker.get('high') is not None else last_price + spread,
                'low': float(ticker['low']) if ticker.get('low') is not None else last_price - spread,
                'close': last_price,
                'volume': float(ticker['baseVolume']) if ticker.get('baseVolume') is not None else 0,
                'timestamp': timestamp
            }

            self.price_cache[symbol] = bar
            self._update_history(symbol, bar)

            return bar

        except Exception:
            # Silently return cached data on errors
            return self.price_cache.get(symbol)

    def _update_history(self, symbol: str, bar: dict):
        """Add bar to history cache."""
        if symbol in self.history_cache:
            self.history_cache[symbol].append(bar)

    def get_snapshot(self) -> Dict[str, dict]:
        """
        Get current prices for all symbols.

        Returns:
            Dict mapping symbol to price bar
        """
        snapshot = {}

        # Fetch stocks
        for symbol in self.STOCK_SYMBOLS:
            bar = self.get_price(symbol)
            if bar:
                snapshot[symbol] = bar

        # Fetch crypto
        for symbol in self.CRYPTO_SYMBOLS.keys():
            bar = self.get_price(symbol)
            if bar:
                snapshot[symbol] = bar

        return snapshot

    def get_history(self, symbol: str, limit: int = 100) -> List[dict]:
        """
        Get historical price data for a symbol.

        Args:
            symbol: The symbol to fetch history for
            limit: Maximum number of bars to return

        Returns:
            List of price bars (oldest first)
        """
        if symbol in self.history_cache:
            history = list(self.history_cache[symbol])
            return history[-limit:] if len(history) > limit else history

        # Try to fetch from source if cache is empty
        if self.is_crypto(symbol):
            return self._fetch_crypto_history(symbol, limit)
        elif self.is_stock(symbol):
            return self._fetch_stock_history(symbol, limit)

        return []

    def _fetch_stock_history(self, symbol: str, limit: int) -> List[dict]:
        """Fetch historical stock data from yfinance."""
        if not YFINANCE_AVAILABLE:
            return []

        try:
            ticker = yf.Ticker(symbol)
            period = "5d" if limit <= 100 else "1mo"
            hist = ticker.history(period=period, interval="1m")

            bars = []
            for index, row in hist.iterrows():
                bar = {
                    'symbol': symbol,
                    'open': float(row['Open']),
                    'high': float(row['High']),
                    'low': float(row['Low']),
                    'close': float(row['Close']),
                    'volume': float(row['Volume']),
                    'timestamp': int(index.timestamp() * 1000)
                }
                bars.append(bar)
                self.history_cache[symbol].append(bar)

            return bars[-limit:]

        except Exception:
            # Silently return empty on error (market closed, etc.)
            return []

    def _fetch_crypto_history(self, symbol: str, limit: int) -> List[dict]:
        """Fetch historical crypto data from Coinbase."""
        if not CCXT_AVAILABLE or self.exchange is None:
            return []

        pair = self.CRYPTO_SYMBOLS.get(symbol)
        if not pair:
            return []

        try:
            ohlcv = self.exchange.fetch_ohlcv(pair, timeframe='1m', limit=limit)

            bars = []
            for candle in ohlcv:
                bar = {
                    'symbol': symbol,
                    'open': float(candle[1]),
                    'high': float(candle[2]),
                    'low': float(candle[3]),
                    'close': float(candle[4]),
                    'volume': float(candle[5]),
                    'timestamp': int(candle[0])
                }
                bars.append(bar)
                self.history_cache[symbol].append(bar)

            return bars

        except Exception:
            # Silently return empty on error
            return []

    def warmup(self, limit: int = 200):
        """
        Pre-fetch historical data for all symbols.
        Call this on startup to populate caches.
        """
        print("DataFeed: Warming up caches...")

        # Crypto first (always available)
        crypto_loaded = 0
        for symbol in self.CRYPTO_SYMBOLS.keys():
            try:
                history = self.get_history(symbol, limit)
                if history:
                    crypto_loaded += 1
                    print(f"  {symbol}: {len(history)} bars loaded")
            except Exception:
                pass

        # Stocks (may fail outside market hours)
        stocks_loaded = 0
        stocks_failed = []
        for symbol in self.STOCK_SYMBOLS:
            try:
                history = self.get_history(symbol, limit)
                if history:
                    stocks_loaded += 1
                    print(f"  {symbol}: {len(history)} bars loaded")
                else:
                    stocks_failed.append(symbol)
            except Exception:
                stocks_failed.append(symbol)

        if stocks_failed:
            print(f"  Note: {len(stocks_failed)} stocks unavailable (market may be closed)")

        print(f"DataFeed: Warmup complete - {crypto_loaded} crypto, {stocks_loaded} stocks ready")


# Singleton instance
_data_feed: Optional[DataFeed] = None


def get_data_feed() -> DataFeed:
    """Get the singleton DataFeed instance."""
    global _data_feed
    if _data_feed is None:
        _data_feed = DataFeed()
    return _data_feed
