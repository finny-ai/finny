"""
Arena Module for Finny Simulator

Manages the trading simulation loop:
- Executes strategies on each tick
- Tracks positions and equity
- Applies fees and slippage
- Broadcasts updates
"""

import time
import threading
import importlib.util
import sys
import os
from datetime import datetime
from typing import Dict, List, Optional, Callable
from collections import deque
from dataclasses import dataclass, field

from .data_feed import get_data_feed, DataFeed
from .validator import validate_code
from . import database as db


@dataclass
class Position:
    """Represents a position in an asset."""
    symbol: str
    quantity: float = 0.0
    entry_price: float = 0.0
    current_price: float = 0.0

    @property
    def value(self) -> float:
        return self.quantity * self.current_price

    @property
    def pnl(self) -> float:
        if self.quantity == 0:
            return 0.0
        return (self.current_price - self.entry_price) * self.quantity

    @property
    def pnl_percent(self) -> float:
        if self.entry_price == 0 or self.quantity == 0:
            return 0.0
        return ((self.current_price - self.entry_price) / self.entry_price) * 100


@dataclass
class Agent:
    """Represents a deployed trading agent."""
    name: str
    strategy: object
    symbol: str
    position: Position
    cash: float = 10000.0
    starting_cash: float = 10000.0
    total_fees: float = 0.0
    trade_count: int = 0
    trade_history: List[dict] = field(default_factory=list)
    username: str = 'anonymous'
    db_id: Optional[int] = None

    @property
    def equity(self) -> float:
        return self.cash + self.position.value

    @property
    def roi(self) -> float:
        return ((self.equity - self.starting_cash) / self.starting_cash) * 100


class Arena:
    """
    Trading arena that manages strategy execution.
    """

    # Trading parameters
    FEE_RATE = 0.00075  # 0.075% per trade (realistic Binance rate)
    SLIPPAGE_RATE = 0.0001  # 0.01% slippage
    TICK_INTERVAL = 1.0  # Seconds between ticks
    STARTING_CASH = 10000.0

    def __init__(self):
        self.data_feed = get_data_feed()
        self.agents: Dict[str, Agent] = {}
        self.running = False
        self.tick_count = 0
        self.loop_thread: Optional[threading.Thread] = None

        # Event callbacks
        self.on_tick: Optional[Callable[[dict], None]] = None
        self.on_trade: Optional[Callable[[dict], None]] = None
        self.on_error: Optional[Callable[[str, str], None]] = None

        # Tick history for charts
        self.tick_history: deque = deque(maxlen=10000)

        # Strategy directory
        self.strategy_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "strategies"
        )

    def deploy_strategy(self, name: str, code: str, symbol: str = "AAPL", username: str = "anonymous") -> dict:
        """
        Deploy a strategy to the arena.

        Args:
            name: Unique name for the agent
            code: Python source code of the strategy
            symbol: Symbol to trade (default: AAPL)
            username: Username of strategy owner (default: anonymous)

        Returns:
            dict with success status and any errors
        """
        # Validate code first
        validation = validate_code(code)
        if not validation.valid:
            return {
                "success": False,
                "error": "Validation failed",
                "validation": validation.to_dict()
            }

        # Check symbol is supported
        if symbol not in self.data_feed.symbols:
            return {
                "success": False,
                "error": f"Unsupported symbol: {symbol}. Available: {self.data_feed.symbols}"
            }

        try:
            # Create a module from the code
            spec = importlib.util.spec_from_loader(
                f"strategy_{name}",
                loader=None,
                origin="<strategy>"
            )
            module = importlib.util.module_from_spec(spec)

            # Execute the code in the module's namespace
            exec(code, module.__dict__)

            # Get the Strategy class
            if not hasattr(module, 'Strategy'):
                return {
                    "success": False,
                    "error": "No Strategy class found in code"
                }

            # Instantiate the strategy
            strategy = module.Strategy()

            # Register agent in database
            db_id = db.get_or_create_agent(name, symbol, username)

            # Create the agent
            agent = Agent(
                name=name,
                strategy=strategy,
                symbol=symbol,
                position=Position(symbol=symbol),
                cash=self.STARTING_CASH,
                starting_cash=self.STARTING_CASH,
                username=username,
                db_id=db_id
            )

            # Remove existing agent with same name
            if name in self.agents:
                del self.agents[name]

            self.agents[name] = agent

            # Save code to file
            filepath = os.path.join(self.strategy_dir, f"{name}.py")
            os.makedirs(self.strategy_dir, exist_ok=True)
            with open(filepath, 'w') as f:
                f.write(code)

            return {
                "success": True,
                "name": name,
                "symbol": symbol,
                "username": username,
                "validation": validation.to_dict()
            }

        except Exception as e:
            return {
                "success": False,
                "error": f"Failed to load strategy: {str(e)}"
            }

    def load_strategy_file(self, filepath: str, symbol: str = "AAPL") -> dict:
        """
        Load a strategy from a file.

        Args:
            filepath: Path to the strategy file
            symbol: Symbol to trade

        Returns:
            dict with success status
        """
        try:
            with open(filepath, 'r') as f:
                code = f.read()

            name = os.path.splitext(os.path.basename(filepath))[0]
            return self.deploy_strategy(name, code, symbol)

        except FileNotFoundError:
            return {"success": False, "error": f"File not found: {filepath}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def remove_agent(self, name: str) -> bool:
        """Remove an agent from the arena."""
        if name in self.agents:
            del self.agents[name]
            return True
        return False

    def start(self):
        """Start the trading loop."""
        if self.running:
            return

        self.running = True
        self.loop_thread = threading.Thread(target=self._loop, daemon=True)
        self.loop_thread.start()
        print(f"Arena: Started trading loop with {len(self.agents)} agents")

    def stop(self):
        """Stop the trading loop."""
        self.running = False
        if self.loop_thread:
            self.loop_thread.join(timeout=5)
        print("Arena: Stopped trading loop")

    def _loop(self):
        """Main trading loop."""
        while self.running:
            tick_start = time.time()

            try:
                self._process_tick()
            except Exception as e:
                print(f"Arena: Error in tick: {e}")
                if self.on_error:
                    self.on_error("tick_error", str(e))

            # Sleep for remaining interval
            elapsed = time.time() - tick_start
            sleep_time = max(0, self.TICK_INTERVAL - elapsed)
            time.sleep(sleep_time)

    def _process_tick(self):
        """Process a single tick."""
        self.tick_count += 1
        timestamp = int(datetime.now().timestamp() * 1000)

        # Get latest prices
        snapshot = self.data_feed.get_snapshot()

        if not snapshot:
            return

        # Build tick data
        tick_data = {
            "tick": self.tick_count,
            "timestamp": timestamp,
            "prices": snapshot,
            "agents": {}
        }

        # Execute each agent's strategy
        for name, agent in self.agents.items():
            try:
                self._execute_agent(agent, snapshot, tick_data)
            except Exception as e:
                print(f"Arena: Error executing {name}: {e}")
                if self.on_error:
                    self.on_error(name, str(e))

        # Store tick in history
        self.tick_history.append(tick_data)

        # Save snapshots to database every 60 ticks (1 minute at 1-second ticks)
        if self.tick_count % 60 == 0:
            for name, agent in self.agents.items():
                db.save_snapshot(
                    agent_name=name,
                    tick=self.tick_count,
                    equity=agent.equity,
                    cash=agent.cash,
                    position_qty=agent.position.quantity,
                    position_entry=agent.position.entry_price,
                    roi=agent.roi
                )

        # Broadcast tick
        if self.on_tick:
            self.on_tick(tick_data)

    def _execute_agent(self, agent: Agent, snapshot: dict, tick_data: dict):
        """Execute a single agent's strategy."""
        # Get price for agent's symbol
        bar = snapshot.get(agent.symbol)
        if not bar:
            return

        # Update position's current price
        agent.position.current_price = bar['close']

        # Call strategy's on_tick
        try:
            action = agent.strategy.on_tick(bar)
        except Exception as e:
            print(f"Arena: Strategy error for {agent.name}: {e}")
            action = "HOLD"

        # Normalize action
        action = str(action).upper().strip()
        if action not in ("BUY", "SELL", "HOLD"):
            action = "HOLD"

        # Execute action
        if action == "BUY" and agent.position.quantity == 0:
            self._execute_buy(agent, bar)
        elif action == "SELL" and agent.position.quantity > 0:
            self._execute_sell(agent, bar)

        # Record agent state in tick data
        tick_data["agents"][agent.name] = {
            "symbol": agent.symbol,
            "action": action,
            "position": agent.position.quantity,
            "equity": round(agent.equity, 2),
            "cash": round(agent.cash, 2),
            "roi": round(agent.roi, 4),
            "pnl": round(agent.position.pnl, 2)
        }

    def _execute_buy(self, agent: Agent, bar: dict):
        """Execute a buy order."""
        price = bar['open']  # Use open price (no lookahead)

        # Apply slippage (buy at slightly higher price)
        execution_price = price * (1 + self.SLIPPAGE_RATE)

        # Calculate quantity (use all available cash minus fees)
        fee = agent.cash * self.FEE_RATE
        available = agent.cash - fee
        quantity = available / execution_price

        if quantity <= 0:
            return

        # Execute
        agent.cash = 0
        agent.total_fees += fee
        agent.position.quantity = quantity
        agent.position.entry_price = execution_price
        agent.position.current_price = bar['close']
        agent.trade_count += 1

        trade = {
            "tick": self.tick_count,
            "timestamp": int(datetime.now().timestamp() * 1000),
            "action": "BUY",
            "symbol": agent.symbol,
            "price": execution_price,
            "quantity": quantity,
            "fee": fee,
            "cash_after": agent.cash
        }
        agent.trade_history.append(trade)

        # Persist trade to database
        db.save_trade(
            agent_name=agent.name,
            tick=trade["tick"],
            timestamp=trade["timestamp"],
            action="BUY",
            price=execution_price,
            quantity=quantity,
            fee=fee,
            cash_after=agent.cash
        )

        if self.on_trade:
            self.on_trade({
                "agent": agent.name,
                **trade
            })

        print(f"Arena: {agent.name} BUY {quantity:.4f} {agent.symbol} @ ${execution_price:.2f}")

    def _execute_sell(self, agent: Agent, bar: dict):
        """Execute a sell order."""
        if agent.position.quantity <= 0:
            return

        price = bar['open']  # Use open price (no lookahead)

        # Apply slippage (sell at slightly lower price)
        execution_price = price * (1 - self.SLIPPAGE_RATE)

        # Calculate proceeds
        proceeds = agent.position.quantity * execution_price
        fee = proceeds * self.FEE_RATE
        net_proceeds = proceeds - fee

        # Record PnL
        pnl = (execution_price - agent.position.entry_price) * agent.position.quantity

        # Execute
        agent.cash = net_proceeds
        agent.total_fees += fee
        quantity = agent.position.quantity
        agent.position.quantity = 0
        agent.position.entry_price = 0
        agent.trade_count += 1

        trade = {
            "tick": self.tick_count,
            "timestamp": int(datetime.now().timestamp() * 1000),
            "action": "SELL",
            "symbol": agent.symbol,
            "price": execution_price,
            "quantity": quantity,
            "fee": fee,
            "pnl": pnl,
            "cash_after": agent.cash
        }
        agent.trade_history.append(trade)

        # Persist trade to database
        db.save_trade(
            agent_name=agent.name,
            tick=trade["tick"],
            timestamp=trade["timestamp"],
            action="SELL",
            price=execution_price,
            quantity=quantity,
            fee=fee,
            cash_after=agent.cash,
            pnl=pnl
        )

        if self.on_trade:
            self.on_trade({
                "agent": agent.name,
                **trade
            })

        print(f"Arena: {agent.name} SELL {quantity:.4f} {agent.symbol} @ ${execution_price:.2f} (PnL: ${pnl:.2f})")

    def get_status(self) -> dict:
        """Get current arena status."""
        return {
            "running": self.running,
            "tick_count": self.tick_count,
            "agent_count": len(self.agents),
            "agents": {
                name: {
                    "symbol": agent.symbol,
                    "equity": round(agent.equity, 2),
                    "cash": round(agent.cash, 2),
                    "position": round(agent.position.quantity, 6),
                    "roi": round(agent.roi, 4),
                    "trades": agent.trade_count,
                    "fees": round(agent.total_fees, 2)
                }
                for name, agent in self.agents.items()
            }
        }

    def get_leaderboard(self) -> List[dict]:
        """Get sorted leaderboard of agents."""
        agents = [
            {
                "name": name,
                "symbol": agent.symbol,
                "equity": round(agent.equity, 2),
                "roi": round(agent.roi, 4),
                "trades": agent.trade_count,
                "username": agent.username
            }
            for name, agent in self.agents.items()
        ]
        return sorted(agents, key=lambda x: x["roi"], reverse=True)

    def get_users_leaderboard(self) -> List[dict]:
        """
        Get aggregated user stats from active agents.

        Returns users ranked by weighted ROI:
            weighted_roi = sum(agent_equity * agent_roi) / sum(agent_equity)
        """
        user_data = {}

        for agent in self.agents.values():
            username = agent.username
            if username not in user_data:
                user_data[username] = {
                    "username": username,
                    "total_equity": 0.0,
                    "weighted_sum": 0.0,
                    "strategy_count": 0
                }

            user_data[username]["total_equity"] += agent.equity
            user_data[username]["weighted_sum"] += agent.equity * agent.roi
            user_data[username]["strategy_count"] += 1

        # Calculate weighted ROI for each user
        users = []
        for data in user_data.values():
            weighted_roi = data["weighted_sum"] / data["total_equity"] if data["total_equity"] > 0 else 0
            users.append({
                "username": data["username"],
                "total_equity": round(data["total_equity"], 2),
                "weighted_roi": round(weighted_roi, 4),
                "strategy_count": data["strategy_count"]
            })

        return sorted(users, key=lambda x: x["weighted_roi"], reverse=True)

    def reset(self):
        """Reset all agents to starting state."""
        for agent in self.agents.values():
            agent.cash = self.STARTING_CASH
            agent.position = Position(symbol=agent.symbol)
            agent.total_fees = 0
            agent.trade_count = 0
            agent.trade_history = []
            # Reinitialize strategy
            if hasattr(agent.strategy, '__init__'):
                try:
                    agent.strategy.__init__()
                except:
                    pass

        self.tick_count = 0
        self.tick_history.clear()
        print("Arena: Reset complete")


# Singleton instance
_arena: Optional[Arena] = None


def get_arena() -> Arena:
    """Get the singleton Arena instance."""
    global _arena
    if _arena is None:
        _arena = Arena()
    return _arena
