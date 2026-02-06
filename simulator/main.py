#!/usr/bin/env python3
"""
Finny AlgoClash Simulator - Local Trading Server

A local Flask server that simulates paper trading for AI-generated strategies.
Runs on port 8000 by default.

Endpoints:
    GET  /           - API info
    GET  /health     - Health check
    GET  /status     - Arena status and agent info
    GET  /schema     - Strategy interface schema
    GET  /leaderboard - Sorted agent rankings
    POST /deploy     - Deploy a strategy
    POST /start      - Start trading loop
    POST /stop       - Stop trading loop
    POST /reset      - Reset all agents
    DELETE /agent/<name> - Remove an agent
"""

import os
import sys
import json
import requests
from datetime import datetime, timedelta
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from simulator.arena import get_arena, Arena
from simulator.data_feed import get_data_feed
from simulator.validator import validate_code, validate_file
from simulator import database as db
from simulator import indicators

# Serve frontend from /static folder if it exists
static_folder = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'static')
if os.path.exists(static_folder):
    app = Flask(__name__, static_folder=static_folder, static_url_path='')
else:
    app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

# Get singleton instances
arena = get_arena()
data_feed = get_data_feed()

# Track server start time
START_TIME = datetime.now()


@app.route('/')
def root():
    """Serve frontend or API info."""
    # If frontend exists, serve it
    if app.static_folder and os.path.exists(os.path.join(app.static_folder, 'index.html')):
        return app.send_static_file('index.html')
    # Otherwise return API info
    return jsonify({
        "name": "Finny AlgoClash Simulator",
        "version": "1.0.0",
        "status": "running",
        "endpoints": {
            "GET /": "This info",
            "GET /health": "Health check",
            "GET /status": "Arena status",
            "GET /schema": "Strategy interface schema",
            "GET /leaderboard": "Agent rankings",
            "GET /leaderboard/history": "Historical leaderboard from DB",
            "GET /symbols": "Available trading symbols",
            "GET /prices": "Current market prices",
            "GET /history/<symbol>": "Price history for a symbol",
            "GET /indicators/<symbol>/rsi": "RSI indicator",
            "GET /indicators/<symbol>/macd": "MACD indicator",
            "GET /indicators/<symbol>/bollinger": "Bollinger Bands",
            "GET /indicators/<symbol>/volatility": "Historical volatility",
            "GET /indicators/<symbol>/sma": "Simple Moving Average",
            "GET /indicators/<symbol>/ema": "Exponential Moving Average",
            "GET /indicators/<symbol>/all": "All indicators",
            "GET /indicators/correlation?a=X&b=Y": "Correlation between two symbols",
            "GET /agent/<name>/code": "Get strategy source code",
            "GET /agent/<name>/stats": "Get detailed agent stats",
            "GET /agent/<name>/history": "Trade history from DB",
            "GET /agent/<name>/equity-history": "Equity history from DB",
            "GET /users": "List all users and their strategies",
            "GET /strategies": "List all strategy files (deployed and non-deployed)",
            "POST /deploy": "Deploy a strategy",
            "POST /validate": "Validate strategy code",
            "POST /backtest": "Run backtest on a strategy",
            "POST /edit/<name>": "Edit strategy code",
            "POST /start": "Start trading",
            "POST /stop": "Stop trading",
            "POST /reset": "Reset all agents",
            "DELETE /agent/<name>": "Remove an agent"
        }
    })


@app.route('/health')
def health():
    """Health check endpoint."""
    uptime = (datetime.now() - START_TIME).total_seconds()
    return jsonify({
        "status": "healthy",
        "uptime_seconds": round(uptime, 2),
        "arena_running": arena.running,
        "agent_count": len(arena.agents),
        "tick_count": arena.tick_count
    })


@app.route('/status')
def status():
    """Get detailed arena status."""
    return jsonify(arena.get_status())


@app.route('/schema')
def schema():
    """Return the strategy interface schema."""
    return jsonify({
        "interface": {
            "class_name": "Strategy",
            "methods": {
                "__init__": {
                    "description": "Initialize strategy state",
                    "parameters": ["self"],
                    "required_attributes": ["position"]
                },
                "on_tick": {
                    "description": "Called on each market tick",
                    "parameters": ["self", "bar"],
                    "returns": "str: 'BUY', 'SELL', or 'HOLD'",
                    "bar_schema": {
                        "symbol": "str - Asset symbol (e.g., 'AAPL', 'BTC')",
                        "open": "float - Opening price",
                        "high": "float - Highest price",
                        "low": "float - Lowest price",
                        "close": "float - Closing price",
                        "volume": "float - Trading volume",
                        "timestamp": "int - Unix timestamp (milliseconds)"
                    }
                }
            }
        },
        "rules": {
            "lookahead_bias": "Use bar['open'] for entries, not bar['close']",
            "position_tracking": "Use self.position (0=flat, 1=long)",
            "forbidden_imports": ["os", "subprocess", "sys", "socket", "requests"],
            "forbidden_functions": ["exec", "eval", "compile", "open"]
        },
        "example": '''class Strategy:
    def __init__(self):
        self.position = 0
        self.prices = []

    def on_tick(self, bar: dict) -> str:
        self.prices.append(bar['open'])
        if len(self.prices) < 10:
            return "HOLD"

        avg = sum(self.prices[-10:]) / 10
        if bar['open'] > avg and self.position == 0:
            self.position = 1
            return "BUY"
        elif bar['open'] < avg and self.position == 1:
            self.position = 0
            return "SELL"
        return "HOLD"
'''
    })


@app.route('/symbols')
def symbols():
    """Get available trading symbols."""
    return jsonify({
        "stocks": data_feed.STOCK_SYMBOLS,
        "crypto": list(data_feed.CRYPTO_SYMBOLS.keys()),
        "all": data_feed.symbols
    })


@app.route('/leaderboard')
def leaderboard():
    """Get sorted agent rankings."""
    return jsonify({
        "timestamp": datetime.now().isoformat(),
        "leaderboard": arena.get_leaderboard()
    })


@app.route('/deploy', methods=['POST'])
def deploy():
    """
    Deploy a strategy to the arena.

    Request JSON:
        {
            "name": "my_strategy",
            "code": "class Strategy: ...",
            "symbol": "AAPL",  // optional, defaults to AAPL
            "username": "user123"  // optional, defaults to anonymous
        }
    """
    data = request.json
    if not data:
        return jsonify({"error": "No JSON data provided"}), 400

    name = data.get('name')
    code = data.get('code')
    symbol = data.get('symbol', 'AAPL')
    username = data.get('username', 'anonymous')

    if not name:
        return jsonify({"error": "Missing 'name' field"}), 400
    if not code:
        return jsonify({"error": "Missing 'code' field"}), 400

    result = arena.deploy_strategy(name, code, symbol, username)

    if result.get('success'):
        # Track successful deploy
        db.increment_stat('total_deploys')
        return jsonify(result)
    else:
        return jsonify(result), 400


@app.route('/validate', methods=['POST'])
def validate():
    """
    Validate strategy code without deploying.

    Request JSON:
        { "code": "class Strategy: ..." }

    Or form data:
        file: strategy file upload
    """
    # Check for file upload
    if 'file' in request.files:
        file = request.files['file']
        code = file.read().decode('utf-8')
    else:
        data = request.json
        if not data or 'code' not in data:
            return jsonify({"error": "Missing 'code' field or file upload"}), 400
        code = data['code']

    result = validate_code(code)
    return jsonify(result.to_dict())


@app.route('/start', methods=['POST'])
def start():
    """Start the trading loop."""
    if arena.running:
        return jsonify({"status": "already_running"})

    arena.start()
    return jsonify({"status": "started", "agent_count": len(arena.agents)})


@app.route('/stop', methods=['POST'])
def stop():
    """Stop the trading loop."""
    if not arena.running:
        return jsonify({"status": "already_stopped"})

    arena.stop()
    return jsonify({"status": "stopped"})


@app.route('/reset', methods=['POST'])
def reset():
    """Reset all agents to starting state."""
    was_running = arena.running
    if was_running:
        arena.stop()

    arena.reset()

    if was_running:
        arena.start()

    return jsonify({"status": "reset", "agent_count": len(arena.agents)})


@app.route('/agent/<name>', methods=['DELETE'])
def remove_agent(name):
    """Remove an agent from the arena."""
    if arena.remove_agent(name):
        return jsonify({"status": "removed", "name": name})
    else:
        return jsonify({"error": f"Agent '{name}' not found"}), 404


@app.route('/agent/<name>/code')
def agent_code(name):
    """Get the source code for an agent's strategy."""
    # Check if agent exists
    if name not in arena.agents:
        return jsonify({"error": f"Agent '{name}' not found"}), 404

    # Try to read from saved strategy file (use arena's strategy_dir)
    filepath = os.path.join(arena.strategy_dir, f"{name}.py")

    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            code = f.read()
        return jsonify({
            "name": name,
            "code": code,
            "filepath": filepath
        })
    else:
        return jsonify({
            "error": f"Strategy file for '{name}' not found",
            "name": name
        }), 404


@app.route('/agent/<name>/stats')
def agent_stats(name):
    """Get detailed stats for an agent."""
    if name not in arena.agents:
        return jsonify({"error": f"Agent '{name}' not found"}), 404

    agent = arena.agents[name]

    # Calculate peak equity from trade history
    equities = [agent.starting_cash]
    running_equity = agent.starting_cash
    for trade in agent.trade_history:
        if trade.get('action') == 'SELL':
            running_equity += trade.get('pnl', 0)
        equities.append(running_equity)
    equities.append(agent.equity)

    peak_equity = max(equities)
    drawdown = ((peak_equity - agent.equity) / peak_equity * 100) if peak_equity > 0 else 0

    # Calculate winning trades
    winning_trades = len([t for t in agent.trade_history if t.get('pnl', 0) > 0])

    return jsonify({
        "name": name,
        "symbol": agent.symbol,
        "equity": round(agent.equity, 2),
        "cash": round(agent.cash, 2),
        "roi": round(agent.roi, 4),
        "peak_equity": round(peak_equity, 2),
        "drawdown": round(drawdown, 2),
        "trades": agent.trade_count,
        "winning_trades": winning_trades,
        "total_fees": round(agent.total_fees, 2),
        "position": {
            "quantity": round(agent.position.quantity, 6),
            "entry_price": round(agent.position.entry_price, 2),
            "current_price": round(agent.position.current_price, 2),
            "pnl": round(agent.position.pnl, 2),
            "pnl_percent": round(agent.position.pnl_percent, 2)
        },
        "trade_history": agent.trade_history[-10:]  # Last 10 trades
    })


@app.route('/edit/<name>', methods=['POST'])
def edit_strategy(name):
    """Edit an existing strategy's code."""
    data = request.json
    if not data or 'code' not in data:
        return jsonify({"error": "Missing 'code' field"}), 400

    # Get current symbol if agent exists
    symbol = 'AAPL'
    if name in arena.agents:
        symbol = arena.agents[name].symbol

    # Re-deploy with new code
    result = arena.deploy_strategy(name, data['code'], symbol)

    if result.get('success'):
        return jsonify({
            "status": "updated",
            "name": name,
            "validation": result.get('validation', {})
        })
    else:
        return jsonify(result), 400


@app.route('/prices')
def prices():
    """Get current prices for all symbols."""
    snapshot = data_feed.get_snapshot()
    return jsonify({
        "timestamp": datetime.now().isoformat(),
        "prices": snapshot
    })


@app.route('/history/<symbol>')
def history(symbol):
    """Get price history for a symbol."""
    limit = request.args.get('limit', 100, type=int)
    history_data = data_feed.get_history(symbol.upper(), limit)
    return jsonify({
        "symbol": symbol.upper(),
        "count": len(history_data),
        "history": history_data
    })


# ============================================================================
# Technical Indicators Endpoints
# ============================================================================

def get_closes_for_symbol(symbol: str, limit: int = 1000) -> list:
    """Helper to get closing prices for a symbol."""
    history_data = data_feed.get_history(symbol.upper(), limit)
    if not history_data:
        return []
    return [bar.get('close', bar.get('price', 0)) for bar in history_data if bar.get('close') or bar.get('price')]


@app.route('/indicators/<symbol>/rsi')
def indicator_rsi(symbol):
    """
    Calculate RSI for a symbol.

    Query params:
        period: RSI period (default 14)
        limit: Number of historical bars to use (default 1000)
    """
    period = request.args.get('period', 14, type=int)
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    result = indicators.calculate_rsi(closes, period)
    result["symbol"] = symbol.upper()
    return jsonify(result)


@app.route('/indicators/<symbol>/macd')
def indicator_macd(symbol):
    """
    Calculate MACD for a symbol.

    Query params:
        fast: Fast EMA period (default 12)
        slow: Slow EMA period (default 26)
        signal: Signal line period (default 9)
        limit: Number of historical bars to use (default 1000)
    """
    fast = request.args.get('fast', 12, type=int)
    slow = request.args.get('slow', 26, type=int)
    signal = request.args.get('signal', 9, type=int)
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    result = indicators.calculate_macd(closes, fast, slow, signal)
    result["symbol"] = symbol.upper()
    return jsonify(result)


@app.route('/indicators/<symbol>/bollinger')
def indicator_bollinger(symbol):
    """
    Calculate Bollinger Bands for a symbol.

    Query params:
        period: SMA period (default 20)
        std: Number of standard deviations (default 2.0)
        limit: Number of historical bars to use (default 1000)
    """
    period = request.args.get('period', 20, type=int)
    std = request.args.get('std', 2.0, type=float)
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    result = indicators.calculate_bollinger(closes, period, std)
    result["symbol"] = symbol.upper()
    return jsonify(result)


@app.route('/indicators/<symbol>/volatility')
def indicator_volatility(symbol):
    """
    Calculate historical volatility for a symbol.

    Query params:
        period: Lookback period (default 20)
        limit: Number of historical bars to use (default 1000)
    """
    period = request.args.get('period', 20, type=int)
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    result = indicators.calculate_volatility(closes, period)
    result["symbol"] = symbol.upper()
    return jsonify(result)


@app.route('/indicators/<symbol>/sma')
def indicator_sma(symbol):
    """
    Calculate Simple Moving Average for a symbol.

    Query params:
        period: SMA period (default 20)
        limit: Number of historical bars to use (default 1000)
    """
    period = request.args.get('period', 20, type=int)
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    result = indicators.calculate_sma(closes, period)
    result["symbol"] = symbol.upper()
    return jsonify(result)


@app.route('/indicators/<symbol>/ema')
def indicator_ema(symbol):
    """
    Calculate Exponential Moving Average for a symbol.

    Query params:
        period: EMA period (default 20)
        limit: Number of historical bars to use (default 1000)
    """
    period = request.args.get('period', 20, type=int)
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    result = indicators.calculate_ema(closes, period)
    result["symbol"] = symbol.upper()
    return jsonify(result)


@app.route('/indicators/correlation')
def indicator_correlation():
    """
    Calculate correlation between two symbols.

    Query params:
        a: First symbol (required)
        b: Second symbol (required)
        period: Lookback period (optional, uses all data if not specified)
        limit: Number of historical bars to use (default 200)
    """
    symbol_a = request.args.get('a')
    symbol_b = request.args.get('b')

    if not symbol_a or not symbol_b:
        return jsonify({"error": "Both 'a' and 'b' symbols are required"}), 400

    period = request.args.get('period', type=int)
    limit = request.args.get('limit', 1000, type=int)

    closes_a = get_closes_for_symbol(symbol_a, limit)
    closes_b = get_closes_for_symbol(symbol_b, limit)

    if not closes_a:
        return jsonify({"error": f"No price data for {symbol_a}"}), 404
    if not closes_b:
        return jsonify({"error": f"No price data for {symbol_b}"}), 404

    result = indicators.calculate_correlation(closes_a, closes_b, period)
    result["symbol_a"] = symbol_a.upper()
    result["symbol_b"] = symbol_b.upper()
    return jsonify(result)


@app.route('/indicators/<symbol>/all')
def indicator_all(symbol):
    """
    Calculate all indicators for a symbol.

    Returns RSI, MACD, Bollinger Bands, and volatility in one response.

    Query params:
        limit: Number of historical bars to use (default 1000)
    """
    limit = request.args.get('limit', 1000, type=int)

    closes = get_closes_for_symbol(symbol, limit)
    if not closes:
        return jsonify({"error": f"No price data for {symbol}"}), 404

    return jsonify({
        "symbol": symbol.upper(),
        "current_price": closes[-1] if closes else None,
        "data_points": len(closes),
        "rsi": indicators.calculate_rsi(closes),
        "macd": indicators.calculate_macd(closes),
        "bollinger": indicators.calculate_bollinger(closes),
        "volatility": indicators.calculate_volatility(closes)
    })


# ============================================================================
# Database-backed Endpoints (Persisted History)
# ============================================================================

@app.route('/agent/<name>/history')
def agent_history(name):
    """
    Get trade history for an agent from the database.

    Query params:
        limit: Max number of trades (default 100)
    """
    limit = request.args.get('limit', 100, type=int)
    trades = db.get_agent_history(name, limit)

    if not trades:
        # Check if agent exists but has no trades
        agent_info = db.get_agent_info(name)
        if not agent_info:
            return jsonify({"error": f"Agent '{name}' not found in database"}), 404

    return jsonify({
        "name": name,
        "count": len(trades),
        "trades": trades
    })


@app.route('/agent/<name>/equity-history')
def agent_equity_history(name):
    """
    Get equity history (snapshots) for an agent from the database.

    Query params:
        limit: Max number of snapshots (default 500)
    """
    limit = request.args.get('limit', 500, type=int)
    snapshots = db.get_equity_history(name, limit)

    if not snapshots:
        agent_info = db.get_agent_info(name)
        if not agent_info:
            return jsonify({"error": f"Agent '{name}' not found in database"}), 404

    return jsonify({
        "name": name,
        "count": len(snapshots),
        "snapshots": snapshots
    })


@app.route('/leaderboard/history')
def leaderboard_history():
    """
    Get historical leaderboard from the database.

    Returns the latest equity/ROI for each agent from snapshots.
    """
    limit = request.args.get('limit', 100, type=int)
    history_data = db.get_leaderboard_history(limit)

    return jsonify({
        "timestamp": datetime.now().isoformat(),
        "count": len(history_data),
        "leaderboard": history_data
    })


@app.route('/users')
def users():
    """
    Get all users and their strategies from the database.
    """
    users_data = db.get_users()

    return jsonify({
        "count": len(users_data),
        "users": users_data
    })


@app.route('/users/leaderboard')
def users_leaderboard():
    """
    Get aggregated user stats for leaderboard.

    Returns users ranked by weighted ROI from active agents.
    Falls back to database if no active agents.

    Query params:
        limit: Max number of users (default 100)
    """
    limit = request.args.get('limit', 100, type=int)

    # Try to get live data from arena first
    users_data = arena.get_users_leaderboard()

    # If no active agents, fall back to database
    if not users_data:
        users_data = db.get_users_leaderboard(limit)

    return jsonify({
        "timestamp": datetime.now().isoformat(),
        "leaderboard": users_data
    })


@app.route('/user/<username>/agents')
def user_agents(username):
    """
    Get all agents for a specific user.

    Returns agent list with name, symbol, equity, roi, trades.
    Uses live data from arena if available, falls back to database.
    """
    # Get live agent data from arena
    live_agents = []
    for name, agent in arena.agents.items():
        if agent.username == username:
            live_agents.append({
                "name": name,
                "symbol": agent.symbol,
                "equity": round(agent.equity, 2),
                "roi": round(agent.roi, 4),
                "trades": agent.trade_count,
                "created_at": None  # Not available from live agent
            })

    if live_agents:
        # Sort by ROI descending
        live_agents.sort(key=lambda x: x["roi"], reverse=True)
        return jsonify({
            "username": username,
            "agents": live_agents
        })

    # Fall back to database
    db_agents = db.get_user_agents(username)

    if not db_agents:
        return jsonify({"error": f"User '{username}' not found or has no agents"}), 404

    return jsonify({
        "username": username,
        "agents": db_agents
    })


@app.route('/stats')
def platform_stats():
    """
    Get platform-wide statistics.

    Returns total deploys, users, trades, and other metrics.
    """
    # Track visit
    db.increment_stat('total_visits')

    stats = db.get_platform_stats()
    stats['active_agents'] = len(arena.agents)
    stats['simulation_running'] = arena.running
    stats['tick_count'] = arena.tick_count

    return jsonify({
        "timestamp": datetime.now().isoformat(),
        "stats": stats
    })


@app.route('/strategies')
def strategies():
    """
    Get all strategy files (deployed and non-deployed).

    Returns a list of strategy files with their names and symbols.
    """
    strategy_list = []

    # Get deployed strategies
    for name, agent in arena.agents.items():
        strategy_list.append({
            "name": name,
            "symbol": agent.symbol,
            "deployed": True,
            "roi": round(agent.roi, 2)
        })

    # Get strategy files from disk
    strategy_dir = arena.strategy_dir
    if os.path.exists(strategy_dir):
        for filename in os.listdir(strategy_dir):
            if filename.endswith('.py') and not filename.startswith('_'):
                name = filename[:-3]  # Remove .py extension
                # Skip if already deployed
                if name not in arena.agents:
                    # Try to detect symbol from file
                    symbol = "Unknown"
                    filepath = os.path.join(strategy_dir, filename)
                    try:
                        with open(filepath, 'r') as f:
                            code = f.read()
                        detected = extract_symbol_from_code(code, name)
                        if detected:
                            symbol = detected
                    except:
                        pass

                    strategy_list.append({
                        "name": name,
                        "symbol": symbol,
                        "deployed": False
                    })

    return jsonify({
        "count": len(strategy_list),
        "strategies": strategy_list
    })


@app.route('/strategy/<name>/code')
def strategy_code(name):
    """Get the source code for any strategy file (deployed or not)."""
    filepath = os.path.join(arena.strategy_dir, f"{name}.py")

    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            code = f.read()
        return jsonify({
            "name": name,
            "code": code,
            "filepath": filepath
        })
    else:
        return jsonify({
            "error": f"Strategy file '{name}.py' not found",
            "name": name
        }), 404


@app.route('/strategy/<name>/deploy', methods=['POST'])
def strategy_deploy(name):
    """Deploy a strategy by name (reads code from file)."""
    filepath = os.path.join(arena.strategy_dir, f"{name}.py")

    if not os.path.exists(filepath):
        return jsonify({"error": f"Strategy file '{name}.py' not found"}), 404

    # Read the code
    with open(filepath, 'r') as f:
        code = f.read()

    # Get optional parameters
    data = request.json or {}
    symbol = data.get('symbol', 'BTC')
    initial_equity = data.get('initial_equity', 10000)
    username = data.get('username', 'anonymous')

    # Try to extract symbol from code if not specified
    if symbol == 'BTC':
        detected = extract_symbol_from_code(code, name)
        if detected:
            symbol = detected

    # Deploy
    result = arena.deploy_strategy(name, code, symbol, username)

    if result.get('success'):
        db.increment_stat('total_deploys')
        return jsonify({
            "message": f"Strategy '{name}' deployed successfully",
            "name": name,
            "symbol": symbol,
            "initial_equity": initial_equity
        })
    else:
        return jsonify({"error": result.get('error', 'Deploy failed')}), 400


@app.route('/backtest', methods=['GET'])
def backtest_info():
    """Info about backtest endpoint (GET request)."""
    return jsonify({
        "endpoint": "/backtest",
        "method": "POST",
        "params": {
            "strategy": "Strategy name (required)",
            "period": "1m, 3m, 6m, 1y (default: 3m)",
            "interval": "1h, 4h, 1d (default: 1h)",
            "capital": "Starting capital (default: 10000)"
        },
        "status": "ready"
    })


@app.route('/backtest', methods=['POST'])
def backtest():
    """
    Run a backtest on a strategy with real historical data.

    Request JSON:
        {
            "strategy": "my_strategy",
            "period": "3m",  // 1m, 3m, 6m, 1y
            "interval": "1h",  // 1h, 4h, 1d
            "capital": 10000
        }
    """
    print("=== BACKTEST REQUEST RECEIVED ===")
    try:
        data = request.json
        print(f"Request data: {data}")
        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        strategy_name = data.get('strategy')
        period = data.get('period', '3m')
        interval = data.get('interval', '1h')
        capital = float(data.get('capital', 10000))

        print(f"Strategy: {strategy_name}, Period: {period}, Interval: {interval}, Capital: {capital}")

        if not strategy_name:
            return jsonify({"error": "Missing 'strategy' field"}), 400

        # Get the strategy code
        filepath = os.path.join(arena.strategy_dir, f"{strategy_name}.py")
        print(f"Strategy file path: {filepath}")
        if not os.path.exists(filepath):
            return jsonify({"error": f"Strategy '{strategy_name}' not found at {filepath}"}), 404

        try:
            with open(filepath, 'r') as f:
                code = f.read()
            print(f"Loaded strategy code ({len(code)} bytes)")
        except Exception as e:
            return jsonify({"error": f"Failed to read strategy: {str(e)}"}), 500

        # Validate code first
        print("Validating strategy code...")
        validation = validate_code(code)
        if not validation.valid:
            print(f"Validation failed: {validation.errors}")
            return jsonify({
                "error": "Strategy validation failed",
                "validation": validation.to_dict()
            }), 400
        print("Validation passed")

        # Get symbol from: 1) request, 2) deployed agent, 3) strategy code, 4) filename, 5) default
        symbol = data.get('symbol')

        if not symbol and strategy_name in arena.agents:
            symbol = arena.agents[strategy_name].symbol

        if not symbol:
            # Try to extract from strategy code
            symbol = extract_symbol_from_code(code, strategy_name)

        if not symbol:
            symbol = "BTC"

        print(f"Trading symbol: {symbol}")

        # Fetch real historical data with the correct timeframe
        print(f"Fetching historical data for {symbol}...")
        history = fetch_backtest_history(symbol, period, interval)
        print(f"Got {len(history) if history else 0} bars")

        if not history or len(history) < 10:
            return jsonify({
                "error": f"Insufficient historical data for {symbol}. Got {len(history) if history else 0} bars.",
                "hint": "Try a shorter period or different symbol"
            }), 400

        # Run backtest
        print("Running backtest simulation...")
        result = run_backtest(code, history, capital, arena.FEE_RATE, arena.SLIPPAGE_RATE)
        result["symbol"] = symbol
        result["period"] = period
        result["interval"] = interval
        result["bars_processed"] = len(history)
        print(f"Backtest complete: {result['total_return']}% return")
        return jsonify(result)

    except Exception as e:
        import traceback
        print("=== BACKTEST ERROR ===")
        traceback.print_exc()
        return jsonify({"error": f"Backtest failed: {str(e)}"}), 500


def extract_symbol_from_code(code: str, strategy_name: str) -> str | None:
    """
    Extract trading symbol from strategy code or filename.

    Checks:
    1. SYMBOL class attribute (e.g., SYMBOL = "PLTR")
    2. self.symbol = "..." in __init__
    3. Strategy filename prefix (e.g., pltr_earnings -> PLTR)
    4. Common tickers in filename
    5. Tickers mentioned in docstrings/comments
    6. Default to BTC for generic strategies
    """
    import re

    # Common tickers to look for
    known_tickers = [
        'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA',
        'PLTR', 'AMD', 'INTC', 'NFLX', 'DIS', 'BA', 'JPM', 'GS', 'V', 'MA',
        'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'DOT', 'LINK', 'AVAX',
        'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'VOO'
    ]

    # 1. Look for SYMBOL = "..." or symbol = "..." in code
    symbol_match = re.search(r'(?:SYMBOL|symbol)\s*=\s*["\']([A-Z]{1,5})["\']', code)
    if symbol_match:
        return symbol_match.group(1).upper()

    # 2. Look for self.symbol = "..." in __init__
    self_symbol_match = re.search(r'self\.symbol\s*=\s*["\']([A-Z]{1,5})["\']', code)
    if self_symbol_match:
        return self_symbol_match.group(1).upper()

    name_upper = strategy_name.upper()

    # 3. Check if filename starts with a known ticker
    for ticker in known_tickers:
        if name_upper.startswith(ticker + '_') or name_upper.startswith(ticker + '-'):
            return ticker
        if name_upper == ticker:
            return ticker

    # 4. Check if any known ticker appears in the filename
    for ticker in known_tickers:
        if ticker in name_upper:
            return ticker

    # 5. Look for tickers in docstrings/comments (first 500 chars)
    # This catches cases like "PLTR Earnings Strategy" in docstring
    code_upper = code[:500].upper()
    for ticker in known_tickers:
        # Look for ticker as a word (not part of another word)
        if re.search(rf'\b{ticker}\b', code_upper):
            return ticker

    # 6. Default to BTC for generic/unknown strategies
    # This ensures strategies can still be backtested
    return 'BTC'


def fetch_backtest_history(symbol: str, period: str, interval: str) -> list:
    """
    Fetch historical data for backtesting.

    Priority:
    1. ccxt/Coinbase (crypto)
    2. yfinance (stocks) - free, try first
    3. Financial Datasets API (stocks) - fallback if yfinance fails

    Args:
        symbol: Trading symbol (BTC, ETH, AAPL, etc.)
        period: Time period (1m, 3m, 6m, 1y)
        interval: Bar interval (1h, 4h, 1d)

    Returns:
        List of OHLCV bars
    """
    # Check if it's crypto or stock
    is_crypto = symbol in data_feed.CRYPTO_SYMBOLS

    if is_crypto:
        return fetch_crypto_history(symbol, period, interval)
    else:
        # Try yfinance first (free)
        period_map = {"1m": "1mo", "3m": "3mo", "6m": "6mo", "1y": "1y"}
        interval_map = {"1h": "1h", "4h": "4h", "1d": "1d"}
        history = fetch_stock_history(symbol, period_map.get(period, "3mo"), interval_map.get(interval, "1h"))

        if history and len(history) >= 10:
            return history

        # Fallback to Financial Datasets API if yfinance fails
        print(f"yfinance unavailable for {symbol}, falling back to Financial Datasets API")
        return fetch_financial_datasets_history(symbol, period, interval)


def fetch_financial_datasets_history(symbol: str, period: str, interval: str) -> list:
    """
    Fetch historical stock data from Financial Datasets API.

    This is the primary data source for stock backtesting as it provides
    reliable historical data going back years.

    Args:
        symbol: Stock ticker (AAPL, NVDA, PLTR, etc.)
        period: Time period (1m, 3m, 6m, 1y)
        interval: Bar interval (1h, 4h, 1d)

    Returns:
        List of OHLCV bars
    """
    api_key = os.getenv('FINANCIAL_DATASETS_API_KEY')
    if not api_key:
        print("FINANCIAL_DATASETS_API_KEY not found in environment")
        return []

    try:
        # Calculate date range based on period
        end_date = datetime.now()
        period_days = {
            "1m": 30,
            "3m": 90,
            "6m": 180,
            "1y": 365
        }
        days = period_days.get(period, 90)
        start_date = end_date - timedelta(days=days)

        # Map interval to Financial Datasets format
        # Financial Datasets supports: minute, 5minute, 15minute, hour, 4hour, day
        interval_map = {
            "1m": "minute",
            "5m": "5minute",
            "15m": "15minute",
            "1h": "hour",
            "4h": "4hour",
            "1d": "day"
        }
        fd_interval = interval_map.get(interval, "hour")

        # Build API request
        base_url = "https://api.financialdatasets.ai"
        headers = {"X-API-KEY": api_key}
        params = {
            "ticker": symbol,
            "interval": fd_interval,
            "start_date": start_date.strftime("%Y-%m-%d"),
            "end_date": end_date.strftime("%Y-%m-%d")
        }

        print(f"Fetching from Financial Datasets: {symbol} ({fd_interval}) {start_date.strftime('%Y-%m-%d')} to {end_date.strftime('%Y-%m-%d')}")

        response = requests.get(
            f"{base_url}/prices",
            params=params,
            headers=headers,
            timeout=30
        )

        if response.status_code != 200:
            print(f"Financial Datasets API error: {response.status_code} - {response.text[:200]}")
            return []

        data = response.json()

        # Handle different response formats
        prices = data.get('prices', data) if isinstance(data, dict) else data
        if not prices or not isinstance(prices, list):
            print(f"No price data returned from Financial Datasets for {symbol}")
            return []

        # Convert to our bar format
        bars = []
        for item in prices:
            try:
                # Handle timestamp - could be ISO string or unix timestamp
                timestamp = item.get('time') or item.get('timestamp') or item.get('date')
                if isinstance(timestamp, str):
                    # Parse ISO format date/datetime
                    if 'T' in timestamp:
                        dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                    else:
                        dt = datetime.strptime(timestamp, "%Y-%m-%d")
                    timestamp_ms = int(dt.timestamp() * 1000)
                else:
                    timestamp_ms = int(timestamp * 1000) if timestamp < 10000000000 else int(timestamp)

                bar = {
                    'symbol': symbol,
                    'open': float(item.get('open', 0)),
                    'high': float(item.get('high', 0)),
                    'low': float(item.get('low', 0)),
                    'close': float(item.get('close', 0)),
                    'volume': float(item.get('volume', 0)),
                    'timestamp': timestamp_ms
                }

                # Skip bars with invalid prices
                if bar['open'] > 0 and bar['close'] > 0:
                    bars.append(bar)

            except Exception as e:
                print(f"Error parsing bar: {e}")
                continue

        # Sort by timestamp (oldest first)
        bars.sort(key=lambda x: x['timestamp'])

        print(f"Financial Datasets: Fetched {len(bars)} bars for {symbol}")
        return bars

    except requests.exceptions.Timeout:
        print("Financial Datasets API timeout")
        return []
    except requests.exceptions.RequestException as e:
        print(f"Financial Datasets API request error: {e}")
        return []
    except Exception as e:
        print(f"Error fetching from Financial Datasets: {e}")
        import traceback
        traceback.print_exc()
        return []


def fetch_stock_history(symbol: str, period: str, interval: str) -> list:
    """Fetch stock history from yfinance."""
    try:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        hist = ticker.history(period=period, interval=interval)

        if hist.empty:
            print(f"No data returned for {symbol} with period={period}, interval={interval}")
            return []

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

        print(f"Fetched {len(bars)} bars for {symbol} ({period}, {interval})")
        return bars

    except Exception as e:
        print(f"Error fetching stock history: {e}")
        return []


def fetch_crypto_history(symbol: str, period: str, interval: str) -> list:
    """Fetch crypto history from exchange via ccxt."""
    try:
        import ccxt
        from datetime import datetime, timedelta

        # Calculate how far back to fetch
        period_days = {
            "1m": 30,
            "3m": 90,
            "6m": 180,
            "1y": 365
        }
        days = period_days.get(period, 90)

        # Map interval to ccxt timeframe
        timeframe_map = {
            "1m": "1m",
            "5m": "5m",
            "15m": "15m",
            "1h": "1h",
            "4h": "4h",
            "1d": "1d"
        }
        timeframe = timeframe_map.get(interval, "1h")

        # Calculate since timestamp
        since = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)

        # Get the trading pair
        pair = data_feed.CRYPTO_SYMBOLS.get(symbol, f"{symbol}/USD")

        # Use existing exchange or create new one
        if data_feed.exchange:
            exchange = data_feed.exchange
        else:
            exchange = ccxt.coinbase({'enableRateLimit': True})
            exchange.load_markets()

        # Fetch OHLCV data in chunks (most exchanges limit to 300-1000 candles per request)
        all_bars = []
        current_since = since
        limit = 300  # Coinbase limit

        while True:
            try:
                ohlcv = exchange.fetch_ohlcv(pair, timeframe=timeframe, since=current_since, limit=limit)

                if not ohlcv:
                    break

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
                    all_bars.append(bar)

                # Move to next chunk
                if len(ohlcv) < limit:
                    break

                current_since = ohlcv[-1][0] + 1  # Start from last timestamp + 1ms

                # Safety limit
                if len(all_bars) > 10000:
                    break

            except Exception as e:
                print(f"Error fetching chunk: {e}")
                break

        print(f"Fetched {len(all_bars)} bars for {symbol} ({period}, {interval})")
        return all_bars

    except Exception as e:
        print(f"Error fetching crypto history: {e}")
        import traceback
        traceback.print_exc()
        return []


def run_backtest(code: str, history: list, starting_capital: float,
                 fee_rate: float = 0.00075, slippage_rate: float = 0.0001) -> dict:
    """
    Run a backtest simulation.

    Args:
        code: Strategy Python code
        history: List of OHLCV bars
        starting_capital: Initial capital
        fee_rate: Trading fee rate
        slippage_rate: Slippage rate

    Returns:
        dict with backtest results
    """
    import importlib.util

    # Load strategy
    spec = importlib.util.spec_from_loader("backtest_strategy", loader=None, origin="<strategy>")
    module = importlib.util.module_from_spec(spec)
    exec(code, module.__dict__)

    if not hasattr(module, 'Strategy'):
        raise ValueError("No Strategy class found in code")

    strategy = module.Strategy()

    # Initialize state
    cash = starting_capital
    position_qty = 0.0
    entry_price = 0.0
    total_fees = 0.0
    trades = []
    equities = [starting_capital]
    peak_equity = starting_capital

    # Run simulation
    for bar in history:
        current_price = bar.get('close', bar.get('open', 0))
        if current_price <= 0:
            continue

        # Calculate current equity
        equity = cash + (position_qty * current_price)
        equities.append(equity)
        peak_equity = max(peak_equity, equity)

        # Get strategy action
        try:
            action = strategy.on_tick(bar)
        except Exception as e:
            action = "HOLD"

        action = str(action).upper().strip()
        if action not in ("BUY", "SELL", "HOLD"):
            action = "HOLD"

        # Execute action
        if action == "BUY" and position_qty == 0 and cash > 0:
            price = bar.get('open', current_price)
            if price <= 0:
                continue
            exec_price = price * (1 + slippage_rate)
            fee = cash * fee_rate
            available = cash - fee
            qty = available / exec_price

            if qty > 0:
                cash = 0
                position_qty = qty
                entry_price = exec_price
                total_fees += fee
                trades.append({
                    "action": "BUY",
                    "price": exec_price,
                    "quantity": qty,
                    "fee": fee,
                    "timestamp": bar.get('timestamp', 0)
                })

        elif action == "SELL" and position_qty > 0:
            price = bar.get('open', current_price)
            if price <= 0:
                continue
            exec_price = price * (1 - slippage_rate)
            proceeds = position_qty * exec_price
            fee = proceeds * fee_rate
            net_proceeds = proceeds - fee
            pnl = (exec_price - entry_price) * position_qty

            qty_sold = position_qty
            cash = net_proceeds
            position_qty = 0
            entry_price = 0
            total_fees += fee
            trades.append({
                "action": "SELL",
                "price": exec_price,
                "quantity": qty_sold,
                "fee": fee,
                "pnl": pnl,
                "timestamp": bar.get('timestamp', 0)
            })

    # Calculate final equity
    final_price = history[-1].get('close', 0) if history else 0
    ending_equity = cash + (position_qty * final_price)

    # Calculate metrics
    total_return = ((ending_equity - starting_capital) / starting_capital) * 100

    # Recalculate max drawdown properly
    max_drawdown = 0
    running_peak = starting_capital
    for equity in equities:
        running_peak = max(running_peak, equity)
        if running_peak > 0:
            drawdown = ((running_peak - equity) / running_peak) * 100
            max_drawdown = max(max_drawdown, drawdown)

    winning_trades = len([t for t in trades if t.get('pnl', 0) > 0])
    losing_trades = len([t for t in trades if t.get('pnl', 0) < 0])
    total_trade_count = len([t for t in trades if t['action'] == 'BUY'])

    # Calculate average win/loss
    wins = [t['pnl'] for t in trades if t.get('pnl', 0) > 0]
    losses = [t['pnl'] for t in trades if t.get('pnl', 0) < 0]
    avg_win = sum(wins) / len(wins) if wins else 0
    avg_loss = sum(losses) / len(losses) if losses else 0

    return {
        "starting_capital": round(starting_capital, 2),
        "ending_equity": round(ending_equity, 2),
        "total_return": round(total_return, 2),
        "total_trades": total_trade_count,
        "winning_trades": winning_trades,
        "losing_trades": losing_trades,
        "win_rate": round((winning_trades / total_trade_count * 100) if total_trade_count > 0 else 0, 1),
        "max_drawdown": round(max_drawdown, 2),
        "total_fees": round(total_fees, 2),
        "avg_win": round(avg_win, 2),
        "avg_loss": round(avg_loss, 2),
        "profit_factor": round(abs(sum(wins) / sum(losses)) if losses and sum(losses) != 0 else 0, 2)
    }


# ============================================================================
# Socket.IO Events for Real-Time Dashboard
# ============================================================================

@socketio.on('connect')
def handle_connect():
    """Handle client connection."""
    print(f"Socket.IO: Client connected")
    # Send initial status
    emit('leaderboard_update', arena.get_leaderboard())

    # Send initial market prices if available
    snapshot = data_feed.get_snapshot()
    if snapshot:
        market_prices = {}
        for sym, bar in snapshot.items():
            if isinstance(bar, dict) and 'close' in bar:
                market_prices[sym] = bar['close']

        # Send initial tick bundle so market overview populates
        initial_bundle = {
            "market": {"prices": market_prices},
            "chart": None,
            "leaderboard": arena.get_leaderboard(),
            "users": arena.get_users_leaderboard()
        }
        emit('tick_bundle', initial_bundle)


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection."""
    print(f"Socket.IO: Client disconnected")


@socketio.on('request_history')
def handle_request_history():
    """Send chart history to client."""
    # Build equity history from tick history
    # Frontend expects: { timestamp, price, agentName1: equity1, agentName2: equity2, ... }
    history = []
    for tick_data in list(arena.tick_history)[-500:]:  # Last 500 ticks
        prices = tick_data.get("prices", {})

        # Get first available price
        first_price = None
        for sym, bar in prices.items():
            if isinstance(bar, dict) and 'close' in bar:
                first_price = bar['close']
                break

        # Build history point with agents as flat values
        point = {
            "timestamp": tick_data.get("timestamp", 0),
            "price": first_price or 0,
            "agents": {}
        }

        # Add agent equities as flat values
        for name, agent_data in tick_data.get("agents", {}).items():
            point["agents"][name] = agent_data.get("equity", 10000)

        history.append(point)

    emit('chart_history_response', history)


def broadcast_tick(tick_data: dict):
    """Broadcast tick data to all connected clients."""
    timestamp = tick_data.get("timestamp", 0)
    prices = tick_data.get("prices", {})

    # Get first available price for the chart
    first_price = None
    for sym, bar in prices.items():
        if isinstance(bar, dict) and 'close' in bar:
            first_price = bar['close']
            break

    # Build chart tick - frontend expects agent equity as flat values
    # Format: { time, price, agentName1: equity1, agentName2: equity2, ... }
    chart_tick = {
        "timestamp": timestamp,
        "price": first_price or 0,
        "agents": {}
    }

    for name, agent_data in tick_data.get("agents", {}).items():
        # Frontend spreads tick.agents, so we need equity as the direct value
        chart_tick["agents"][name] = agent_data.get("equity", 10000)

    socketio.emit('chart_tick', chart_tick)

    # Build tick_bundle in expected format: { market, chart, leaderboard }
    # Market prices - flatten bar data to just prices
    market_prices = {}
    for sym, bar in prices.items():
        if isinstance(bar, dict) and 'close' in bar:
            market_prices[sym] = bar['close']

    tick_bundle = {
        "market": {
            "prices": market_prices
        },
        "chart": {
            "timestamp": timestamp,
            "price": first_price or 0,
            "agents": {name: agent_data.get("equity", 10000)
                      for name, agent_data in tick_data.get("agents", {}).items()}
        },
        "leaderboard": arena.get_leaderboard(),
        "users": arena.get_users_leaderboard()
    }

    socketio.emit('tick_bundle', tick_bundle)

    # Also emit standalone leaderboard update periodically (every 5 ticks)
    if tick_data.get("tick", 0) % 5 == 0:
        socketio.emit('leaderboard_update', arena.get_leaderboard())


def broadcast_trade(trade_data: dict):
    """Broadcast trade execution to all connected clients."""
    socketio.emit('trade_log', trade_data)


# Wire up arena callbacks
arena.on_tick = broadcast_tick
arena.on_trade = broadcast_trade


# Catch-all route for frontend client-side routing
@app.route('/dashboard')
@app.route('/leaderboard')
@app.route('/contact')
def serve_frontend_routes():
    """Serve frontend for client-side routes."""
    if app.static_folder and os.path.exists(os.path.join(app.static_folder, 'index.html')):
        return app.send_static_file('index.html')
    return jsonify({"error": "Frontend not available"}), 404


def main():
    """Main entry point."""
    port = int(os.getenv('PORT', 8000))
    debug = os.getenv('DEBUG', 'false').lower() == 'true'

    # Initialize database
    print("Initializing database...")
    db.init_db()

    print(f"""
╔═══════════════════════════════════════════════════════════╗
║           Finny AlgoClash Simulator v1.0.0                ║
╠═══════════════════════════════════════════════════════════╣
║  Local paper trading simulator for AI-generated strategies ║
╚═══════════════════════════════════════════════════════════╝

Server starting on http://localhost:{port}

Endpoints:
  GET  /schema     - Strategy interface documentation
  POST /deploy     - Deploy a strategy
  POST /start      - Start trading
  GET  /status     - View arena status
  GET  /leaderboard - View rankings

Symbols available: {', '.join(data_feed.symbols)}
    """)

    # Warmup data feed
    print("Warming up data feed...")
    data_feed.warmup(limit=200)

    # Use socketio.run for WebSocket support
    socketio.run(app, host='0.0.0.0', port=port, debug=debug, allow_unsafe_werkzeug=True)


if __name__ == '__main__':
    main()
