from collections import deque
from typing import Optional


class Strategy:
    """
    Mean-reversion strategy for USO using Bollinger Bands and RSI filter.

    Entry logic:
    - BUY when price touches lower Bollinger Band AND RSI < oversold threshold
    - SELL when price touches upper Bollinger Band AND RSI > overbought threshold
    - Only enter when volatility > volatility_threshold (avoid ranging markets)

    Exit logic:
    - Take profit at take_profit_pct gain
    - Stop loss at stop_loss_pct loss

    Position sizing:
    - Risk max_risk_per_trade_percent of equity per trade
    - Size = (equity * risk_pct) / stop_distance
    """

    def __init__(self, broker):
        self.broker = broker

        # Configuration (must match config.json keys)
        self.bollinger_period = 20
        self.bollinger_std = 2.0
        self.rsi_period = 14
        self.rsi_oversold = 30
        self.rsi_overbought = 70
        self.volatility_threshold = 0.02
        self.max_risk_per_trade_percent = 1.0
        self.stop_loss_pct = 0.02
        self.take_profit_pct = 0.04

        # Price history for Bollinger Bands (need extra for volatility calc)
        self.prices = deque(maxlen=self.bollinger_period + 50)

        # RSI state - persisted on self per validator rules
        self.rsi_gains = deque(maxlen=self.rsi_period)
        self.rsi_losses = deque(maxlen=self.rsi_period)
        self.prev_price: Optional[float] = None

        # Entry tracking for exits
        self.entry_price: Optional[float] = None

    def on_bar(self, symbol: str, bar: dict) -> None:
        """
        Process each bar using bar["open"] for decisions.
        bar = {'timestamp', 'open', 'high', 'low', 'close', 'volume', 'symbol'}
        """
        price = bar["open"]
        self.prices.append(price)

        # Update RSI state using open prices
        if self.prev_price is not None:
            change = price - self.prev_price
            if change > 0:
                self.rsi_gains.append(change)
                self.rsi_losses.append(0.0)
            elif change < 0:
                self.rsi_gains.append(0.0)
                self.rsi_losses.append(abs(change))
            else:
                self.rsi_gains.append(0.0)
                self.rsi_losses.append(0.0)
        self.prev_price = price

        # Need sufficient data
        if len(self.prices) < self.bollinger_period:
            return
        if len(self.rsi_gains) < self.rsi_period:
            return

        # Calculate Bollinger Bands using sample variance (N-1)
        recent_prices = list(self.prices)[-self.bollinger_period :]
        mean = sum(recent_prices) / self.bollinger_period

        variance = sum((p - mean) ** 2 for p in recent_prices) / (
            self.bollinger_period - 1
        )
        std = variance**0.5

        upper_band = mean + (self.bollinger_std * std)
        lower_band = mean - (self.bollinger_std * std)

        # Calculate volatility as real standard deviation of returns (not RMS)
        if len(self.prices) >= 21:
            returns = []
            prices_for_vol = list(self.prices)[-21:]
            for i in range(1, len(prices_for_vol)):
                ret = (prices_for_vol[i] - prices_for_vol[i - 1]) / prices_for_vol[
                    i - 1
                ]
                returns.append(ret)

            if len(returns) > 1:
                mean_return = sum(returns) / len(returns)
                variance_return = sum((r - mean_return) ** 2 for r in returns) / (
                    len(returns) - 1
                )
                volatility = variance_return**0.5
            else:
                volatility = 0.0
        else:
            volatility = 0.0

        # Calculate RSI with flat-market handling
        avg_gain = sum(self.rsi_gains) / self.rsi_period
        avg_loss = sum(self.rsi_losses) / self.rsi_period

        if avg_gain == 0 and avg_loss == 0:
            # Flat market: RSI = 50 (neutral), NOT 100
            rsi = 50.0
        elif avg_loss == 0:
            rsi = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi = 100.0 - (100.0 / (1.0 + rs))

        # Get current position and equity
        position = self.broker.position(symbol)
        equity = self.broker.equity()

        # Exit logic (check first)
        if position > 0 and self.entry_price is not None:
            profit_pct = (price - self.entry_price) / self.entry_price

            # Take profit
            if profit_pct >= self.take_profit_pct:
                self.broker.sell(symbol)
                self.entry_price = None
                return

            # Stop loss
            if profit_pct <= -self.stop_loss_pct:
                self.broker.sell(symbol)
                self.entry_price = None
                return

        # Entry logic - only if volatility is sufficient
        if volatility < self.volatility_threshold:
            return

        # BUY signal: price at/below lower band AND RSI oversold
        if position == 0 and price <= lower_band and rsi < self.rsi_oversold:
            # Position sizing: risk max_risk_per_trade_percent of equity
            risk_amount = equity * (self.max_risk_per_trade_percent / 100.0)
            stop_distance = price * self.stop_loss_pct

            if stop_distance > 0:
                qty = int(risk_amount / stop_distance)
                if qty > 0:
                    self.broker.buy(symbol, qty=qty)
                    self.entry_price = price

        # SELL signal: price at/above upper band AND RSI overbought
        elif position > 0 and price >= upper_band and rsi > self.rsi_overbought:
            self.broker.sell(symbol)
            self.entry_price = None
