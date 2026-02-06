"""
Database Module for Finny Simulator

SQLite persistence for trades, agent snapshots, and leaderboard history.
All writes are fire-and-forget to avoid blocking tick processing.
"""

import sqlite3
import os
import threading
from typing import Optional, List, Dict, Any
from contextlib import contextmanager

# Database file location
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "finny.db")

# Thread-local storage for connections
_local = threading.local()


def get_connection() -> sqlite3.Connection:
    """Get a thread-local database connection."""
    if not hasattr(_local, 'connection') or _local.connection is None:
        _local.connection = sqlite3.connect(DB_PATH, check_same_thread=False)
        _local.connection.row_factory = sqlite3.Row
        # Enable WAL mode for better concurrent writes
        _local.connection.execute("PRAGMA journal_mode=WAL")
        _local.connection.execute("PRAGMA synchronous=NORMAL")
    return _local.connection


@contextmanager
def get_cursor():
    """Context manager for database cursor."""
    conn = get_connection()
    cursor = conn.cursor()
    try:
        yield cursor
        conn.commit()
    except Exception as e:
        conn.rollback()
        raise e


def init_db():
    """Initialize database tables if they don't exist."""
    with get_cursor() as cursor:
        # Agents table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS agents (
                id INTEGER PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                symbol TEXT NOT NULL,
                username TEXT DEFAULT 'anonymous',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Trades table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY,
                agent_id INTEGER REFERENCES agents(id),
                tick INTEGER,
                timestamp INTEGER,
                action TEXT,
                price REAL,
                quantity REAL,
                fee REAL,
                pnl REAL,
                cash_after REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Snapshots table (periodic state saves)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY,
                agent_id INTEGER REFERENCES agents(id),
                tick INTEGER,
                equity REAL,
                cash REAL,
                position_qty REAL,
                position_entry REAL,
                roi REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Create indexes for faster queries
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_trades_agent_id ON trades(agent_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_snapshots_agent_id ON snapshots(agent_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON snapshots(tick)
        """)

    print("Database: Initialized at", DB_PATH)

    # Initialize stats table
    init_stats_table()


def get_or_create_agent(name: str, symbol: str, username: str = 'anonymous') -> int:
    """
    Get agent ID by name, or create a new agent record.

    Returns:
        int: The agent's database ID
    """
    with get_cursor() as cursor:
        # Try to find existing agent
        cursor.execute("SELECT id FROM agents WHERE name = ?", (name,))
        row = cursor.fetchone()

        if row:
            # Update symbol and username if agent exists
            cursor.execute(
                "UPDATE agents SET symbol = ?, username = ? WHERE name = ?",
                (symbol, username, name)
            )
            return row['id']

        # Create new agent
        cursor.execute(
            "INSERT INTO agents (name, symbol, username) VALUES (?, ?, ?)",
            (name, symbol, username)
        )
        return cursor.lastrowid


def save_trade(
    agent_name: str,
    tick: int,
    timestamp: int,
    action: str,
    price: float,
    quantity: float,
    fee: float,
    cash_after: float,
    pnl: Optional[float] = None
):
    """
    Save a trade record to the database.

    This is fire-and-forget - errors are logged but don't block execution.
    """
    try:
        with get_cursor() as cursor:
            # Get agent ID
            cursor.execute("SELECT id FROM agents WHERE name = ?", (agent_name,))
            row = cursor.fetchone()
            if not row:
                print(f"Database: Agent '{agent_name}' not found, skipping trade save")
                return

            agent_id = row['id']

            cursor.execute("""
                INSERT INTO trades (agent_id, tick, timestamp, action, price, quantity, fee, pnl, cash_after)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (agent_id, tick, timestamp, action, price, quantity, fee, pnl, cash_after))

    except Exception as e:
        print(f"Database: Error saving trade: {e}")


def save_snapshot(
    agent_name: str,
    tick: int,
    equity: float,
    cash: float,
    position_qty: float,
    position_entry: float,
    roi: float
):
    """
    Save a periodic agent state snapshot.

    This is fire-and-forget - errors are logged but don't block execution.
    """
    try:
        with get_cursor() as cursor:
            # Get agent ID
            cursor.execute("SELECT id FROM agents WHERE name = ?", (agent_name,))
            row = cursor.fetchone()
            if not row:
                return

            agent_id = row['id']

            cursor.execute("""
                INSERT INTO snapshots (agent_id, tick, equity, cash, position_qty, position_entry, roi)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (agent_id, tick, equity, cash, position_qty, position_entry, roi))

    except Exception as e:
        print(f"Database: Error saving snapshot: {e}")


def get_agent_history(agent_name: str, limit: int = 100) -> List[Dict[str, Any]]:
    """
    Get trade history for an agent from the database.

    Args:
        agent_name: Name of the agent
        limit: Maximum number of trades to return (default 100)

    Returns:
        List of trade records as dictionaries
    """
    try:
        with get_cursor() as cursor:
            cursor.execute("""
                SELECT t.tick, t.timestamp, t.action, t.price, t.quantity, t.fee, t.pnl, t.cash_after, t.created_at
                FROM trades t
                JOIN agents a ON t.agent_id = a.id
                WHERE a.name = ?
                ORDER BY t.timestamp DESC
                LIMIT ?
            """, (agent_name, limit))

            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    except Exception as e:
        print(f"Database: Error getting agent history: {e}")
        return []


def get_equity_history(agent_name: str, limit: int = 500) -> List[Dict[str, Any]]:
    """
    Get equity history for an agent from snapshots.

    Args:
        agent_name: Name of the agent
        limit: Maximum number of snapshots to return (default 500)

    Returns:
        List of snapshot records as dictionaries
    """
    try:
        with get_cursor() as cursor:
            cursor.execute("""
                SELECT s.tick, s.equity, s.cash, s.position_qty, s.position_entry, s.roi, s.created_at
                FROM snapshots s
                JOIN agents a ON s.agent_id = a.id
                WHERE a.name = ?
                ORDER BY s.tick DESC
                LIMIT ?
            """, (agent_name, limit))

            rows = cursor.fetchall()
            # Return in chronological order
            return [dict(row) for row in reversed(rows)]

    except Exception as e:
        print(f"Database: Error getting equity history: {e}")
        return []


def get_users() -> List[Dict[str, Any]]:
    """
    Get all users and their strategies.

    Returns:
        List of users with their agent names
    """
    try:
        with get_cursor() as cursor:
            cursor.execute("""
                SELECT username, GROUP_CONCAT(name) as strategies, COUNT(*) as strategy_count
                FROM agents
                GROUP BY username
                ORDER BY strategy_count DESC
            """)

            rows = cursor.fetchall()
            result = []
            for row in rows:
                result.append({
                    'username': row['username'],
                    'strategies': row['strategies'].split(',') if row['strategies'] else [],
                    'strategy_count': row['strategy_count']
                })
            return result

    except Exception as e:
        print(f"Database: Error getting users: {e}")
        return []


def get_leaderboard_history(limit: int = 100) -> List[Dict[str, Any]]:
    """
    Get historical leaderboard snapshots (most recent equity for each agent).

    Args:
        limit: Maximum number of entries

    Returns:
        List of agents with their latest equity/ROI
    """
    try:
        with get_cursor() as cursor:
            # Get latest snapshot for each agent
            cursor.execute("""
                SELECT a.name, a.symbol, a.username, s.equity, s.roi, s.tick, s.created_at
                FROM agents a
                LEFT JOIN snapshots s ON a.id = s.agent_id
                WHERE s.id = (
                    SELECT MAX(s2.id) FROM snapshots s2 WHERE s2.agent_id = a.id
                )
                ORDER BY s.roi DESC
                LIMIT ?
            """, (limit,))

            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    except Exception as e:
        print(f"Database: Error getting leaderboard history: {e}")
        return []


def get_agent_info(agent_name: str) -> Optional[Dict[str, Any]]:
    """
    Get agent info from database.

    Args:
        agent_name: Name of the agent

    Returns:
        Agent record as dictionary or None if not found
    """
    try:
        with get_cursor() as cursor:
            cursor.execute(
                "SELECT id, name, symbol, username, created_at FROM agents WHERE name = ?",
                (agent_name,)
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    except Exception as e:
        print(f"Database: Error getting agent info: {e}")
        return None


def init_stats_table():
    """Initialize the stats table for tracking platform metrics."""
    with get_cursor() as cursor:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS platform_stats (
                id INTEGER PRIMARY KEY,
                stat_key TEXT UNIQUE NOT NULL,
                stat_value INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Initialize default stats
        stats = ['total_deploys', 'total_trades', 'total_visits', 'total_backtests']
        for stat in stats:
            cursor.execute("""
                INSERT OR IGNORE INTO platform_stats (stat_key, stat_value) VALUES (?, 0)
            """, (stat,))


def increment_stat(stat_key: str, amount: int = 1):
    """Increment a platform stat by the given amount."""
    try:
        with get_cursor() as cursor:
            cursor.execute("""
                UPDATE platform_stats
                SET stat_value = stat_value + ?, updated_at = CURRENT_TIMESTAMP
                WHERE stat_key = ?
            """, (amount, stat_key))
    except Exception as e:
        print(f"Database: Error incrementing stat: {e}")


def get_users_leaderboard(limit: int = 100) -> List[Dict[str, Any]]:
    """
    Get aggregated user stats for leaderboard.

    Returns users ranked by weighted ROI:
        weighted_roi = sum(agent_equity * agent_roi) / sum(agent_equity)

    Args:
        limit: Maximum number of users to return

    Returns:
        List of users with their aggregated stats
    """
    try:
        with get_cursor() as cursor:
            cursor.execute("""
                SELECT
                    a.username,
                    SUM(s.equity) as total_equity,
                    SUM(s.equity * s.roi) / NULLIF(SUM(s.equity), 0) as weighted_roi,
                    COUNT(DISTINCT a.id) as strategy_count
                FROM agents a
                LEFT JOIN snapshots s ON a.id = s.agent_id
                WHERE s.id = (SELECT MAX(id) FROM snapshots WHERE agent_id = a.id)
                GROUP BY a.username
                ORDER BY weighted_roi DESC
                LIMIT ?
            """, (limit,))

            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    except Exception as e:
        print(f"Database: Error getting users leaderboard: {e}")
        return []


def get_user_agents(username: str) -> List[Dict[str, Any]]:
    """
    Get all agents for a specific user with their latest stats.

    Args:
        username: Username to look up

    Returns:
        List of agent records with name, symbol, equity, roi, trades, created_at
    """
    try:
        with get_cursor() as cursor:
            cursor.execute("""
                SELECT
                    a.name,
                    a.symbol,
                    a.created_at,
                    s.equity,
                    s.roi,
                    (SELECT COUNT(*) FROM trades t WHERE t.agent_id = a.id) as trades
                FROM agents a
                LEFT JOIN snapshots s ON a.id = s.agent_id
                    AND s.id = (SELECT MAX(id) FROM snapshots WHERE agent_id = a.id)
                WHERE a.username = ?
                ORDER BY s.roi DESC
            """, (username,))

            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    except Exception as e:
        print(f"Database: Error getting user agents: {e}")
        return []


def get_platform_stats() -> Dict[str, Any]:
    """
    Get all platform statistics.

    Returns:
        Dictionary with all platform stats
    """
    try:
        with get_cursor() as cursor:
            # Get stat counters
            cursor.execute("SELECT stat_key, stat_value FROM platform_stats")
            stats = {row['stat_key']: row['stat_value'] for row in cursor.fetchall()}

            # Get total unique users
            cursor.execute("SELECT COUNT(DISTINCT username) as count FROM agents")
            stats['total_users'] = cursor.fetchone()['count']

            # Get total strategies ever deployed
            cursor.execute("SELECT COUNT(*) as count FROM agents")
            stats['total_strategies'] = cursor.fetchone()['count']

            # Get total trades from trades table
            cursor.execute("SELECT COUNT(*) as count FROM trades")
            stats['total_trades_recorded'] = cursor.fetchone()['count']

            # Get trades today
            cursor.execute("""
                SELECT COUNT(*) as count FROM trades
                WHERE DATE(created_at) = DATE('now')
            """)
            stats['trades_today'] = cursor.fetchone()['count']

            # Get deploys today
            cursor.execute("""
                SELECT COUNT(*) as count FROM agents
                WHERE DATE(created_at) = DATE('now')
            """)
            stats['deploys_today'] = cursor.fetchone()['count']

            return stats

    except Exception as e:
        print(f"Database: Error getting platform stats: {e}")
        return {}
