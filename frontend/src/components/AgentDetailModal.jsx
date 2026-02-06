import React, { useState, useEffect } from 'react';
import { api } from '../api';

const AgentDetailModal = ({ agent, onClose, logs }) => {
    const [activeTab, setActiveTab] = useState('activity');
    const [agentCode, setAgentCode] = useState(null);
    const [codeLoading, setCodeLoading] = useState(false);
    const [codeError, setCodeError] = useState(null);
    const [tradeHistory, setTradeHistory] = useState([]);
    const [tradesLoading, setTradesLoading] = useState(true);
    const [agentStats, setAgentStats] = useState(null);
    const [equityHistory, setEquityHistory] = useState([]);

    if (!agent) return null;

    // Fetch trade history and detailed stats when modal opens
    useEffect(() => {
        setTradesLoading(true);

        // Fetch trade history
        api.get(`/agent/${agent.name}/history?limit=50`)
            .then(res => {
                setTradeHistory(res.data.trades || []);
                setTradesLoading(false);
            })
            .catch(err => {
                console.log('Trade history fetch error:', err);
                setTradesLoading(false);
            });

        // Fetch detailed agent stats
        api.get(`/agent/${agent.name}/stats`)
            .then(res => {
                setAgentStats(res.data);
            })
            .catch(err => {
                console.log('Agent stats fetch error:', err);
            });

        // Fetch equity history for Sharpe Ratio calculation
        api.get(`/agent/${agent.name}/equity-history?limit=100`)
            .then(res => {
                setEquityHistory(res.data.snapshots || []);
            })
            .catch(err => {
                console.log('Equity history fetch error:', err);
            });
    }, [agent.name]);

    // Calculate Sharpe Ratio from equity history
    const calculateSharpeRatio = () => {
        if (equityHistory.length < 2) return null;

        // Calculate returns
        const returns = [];
        for (let i = 1; i < equityHistory.length; i++) {
            const prevEquity = equityHistory[i - 1].equity;
            const currEquity = equityHistory[i].equity;
            if (prevEquity > 0) {
                returns.push((currEquity - prevEquity) / prevEquity);
            }
        }

        if (returns.length < 2) return null;

        // Calculate mean and std dev
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev === 0) return mean > 0 ? Infinity : 0;

        // Annualize (assuming ~1 minute intervals, ~525600 per year)
        // Simplified: just return the ratio scaled
        const sharpe = (mean / stdDev) * Math.sqrt(365);
        return sharpe;
    };

    // Filter logs for this agent (from real-time WebSocket)
    const realtimeLogs = logs.filter(log =>
        log.agent === agent.name ||
        log.agent_id === agent.name ||
        (log.message && log.message.includes(agent.name))
    );

    // Merge real-time logs with historical trades
    const agentLogs = [...realtimeLogs];
    tradeHistory.forEach(trade => {
        // Add if not already present
        const exists = agentLogs.some(l =>
            l.timestamp === trade.timestamp && l.action === trade.action
        );
        if (!exists) {
            agentLogs.push(trade);
        }
    });
    // Sort by timestamp descending
    agentLogs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const pnl = (agent.equity || 10000) - 10000;
    const roi = agent.roi || (pnl / 10000 * 100);
    const isProfit = roi >= 0;

    // Fetch agent code when switching to algorithm tab
    useEffect(() => {
        if (activeTab === 'algorithm' && !agentCode && !codeLoading) {
            setCodeLoading(true);
            setCodeError(null);

            api.get(`/agent/${agent.name}/code`)
                .then(res => {
                    setAgentCode(res.data.code);
                    setCodeLoading(false);
                })
                .catch(err => {
                    setCodeError(err.response?.data?.error || 'Failed to load code');
                    setCodeLoading(false);
                });
        }
    }, [activeTab, agent.name, agentCode, codeLoading]);

    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 2000
        }} onClick={onClose}>
            <div style={{
                width: '700px',
                maxHeight: '85vh',
                background: 'var(--bg-surface)',
                border: '1px solid var(--bg-border)',
                borderRadius: '16px',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
            }} onClick={e => e.stopPropagation()}>

                {/* Header */}
                <div style={{
                    padding: '24px',
                    borderBottom: '1px solid var(--bg-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                }}>
                    <div>
                        <h2 style={{
                            margin: '0 0 4px 0',
                            color: 'var(--text-primary)',
                            fontSize: '1.25rem',
                            fontWeight: '700'
                        }}>{agent.name}</h2>
                        <span style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '1px'
                        }}>AI Trading Agent</span>
                    </div>
                    <button onClick={onClose} style={{
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--bg-border)',
                        color: 'var(--text-muted)',
                        width: '32px',
                        height: '32px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        fontSize: '1.25rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s'
                    }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--loss)';
                            e.currentTarget.style.color = 'var(--text-primary)';
                            e.currentTarget.style.borderColor = 'var(--loss)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'var(--bg-elevated)';
                            e.currentTarget.style.color = 'var(--text-muted)';
                            e.currentTarget.style.borderColor = 'var(--bg-border)';
                        }}>
                        ×
                    </button>
                </div>

                {/* Stats */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: '1px',
                    background: 'var(--bg-border)'
                }}>
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '20px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            marginBottom: '6px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Equity</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: 'var(--text-primary)'
                        }}>
                            ${(agent.equity || 10000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </div>
                    </div>
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '20px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            marginBottom: '6px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>P&L</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: isProfit ? 'var(--profit)' : 'var(--loss)'
                        }}>
                            {isProfit ? '+' : ''}${pnl.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </div>
                    </div>
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '20px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            marginBottom: '6px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>ROI</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: isProfit ? 'var(--profit)' : 'var(--loss)'
                        }}>
                            {isProfit ? '+' : ''}{roi.toFixed(2)}%
                        </div>
                    </div>
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '20px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.7rem',
                            color: 'var(--text-muted)',
                            marginBottom: '6px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Trades</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: 'var(--text-primary)'
                        }}>
                            {agent.trades || 0}
                        </div>
                    </div>
                </div>

                {/* Secondary Stats Row */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(5, 1fr)',
                    gap: '1px',
                    background: 'var(--bg-border)'
                }}>
                    {/* Symbol */}
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '16px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-muted)',
                            marginBottom: '4px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Symbol</div>
                        <div style={{
                            fontSize: '1rem',
                            fontWeight: '600',
                            color: 'var(--accent-primary)'
                        }}>
                            {agentStats?.symbol || agent.symbol || '—'}
                        </div>
                    </div>

                    {/* Position */}
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '16px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-muted)',
                            marginBottom: '4px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Position</div>
                        <div style={{
                            fontSize: '1rem',
                            fontWeight: '600',
                            color: agentStats?.position?.quantity > 0 ? 'var(--profit)' : 'var(--text-muted)'
                        }}>
                            {agentStats?.position?.quantity > 0
                                ? `${agentStats.position.quantity.toFixed(4)}`
                                : 'Flat'}
                        </div>
                    </div>

                    {/* Max Drawdown */}
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '16px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-muted)',
                            marginBottom: '4px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Max Drawdown</div>
                        <div style={{
                            fontSize: '1rem',
                            fontWeight: '600',
                            color: agentStats?.drawdown > 5 ? 'var(--loss)' : 'var(--text-primary)'
                        }}>
                            {agentStats?.drawdown !== undefined
                                ? `-${agentStats.drawdown.toFixed(2)}%`
                                : '—'}
                        </div>
                    </div>

                    {/* Sharpe Ratio */}
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '16px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-muted)',
                            marginBottom: '4px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Sharpe Ratio</div>
                        <div style={{
                            fontSize: '1rem',
                            fontWeight: '600',
                            color: (() => {
                                const sharpe = calculateSharpeRatio();
                                if (sharpe === null) return 'var(--text-muted)';
                                if (sharpe >= 1) return 'var(--profit)';
                                if (sharpe < 0) return 'var(--loss)';
                                return 'var(--text-primary)';
                            })()
                        }}>
                            {(() => {
                                const sharpe = calculateSharpeRatio();
                                if (sharpe === null) return '—';
                                if (!isFinite(sharpe)) return '∞';
                                return sharpe.toFixed(2);
                            })()}
                        </div>
                    </div>

                    {/* Uptime */}
                    <div style={{
                        background: 'var(--bg-surface)',
                        padding: '16px',
                        textAlign: 'center'
                    }}>
                        <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-muted)',
                            marginBottom: '4px',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}>Uptime</div>
                        <div style={{
                            fontSize: '1rem',
                            fontWeight: '600',
                            color: 'var(--text-primary)'
                        }}>
                            {(() => {
                                // Calculate uptime from first equity snapshot or trade
                                const firstSnapshot = equityHistory[0];
                                const firstTrade = tradeHistory[tradeHistory.length - 1];

                                let startTime = null;
                                if (firstSnapshot?.timestamp) {
                                    startTime = firstSnapshot.timestamp;
                                } else if (firstTrade?.timestamp) {
                                    startTime = firstTrade.timestamp;
                                }

                                if (!startTime) return '—';

                                const now = Date.now();
                                const diff = now - (startTime < 10000000000 ? startTime * 1000 : startTime);
                                const minutes = Math.floor(diff / 60000);
                                const hours = Math.floor(minutes / 60);
                                const days = Math.floor(hours / 24);

                                if (days > 0) return `${days}d ${hours % 24}h`;
                                if (hours > 0) return `${hours}h ${minutes % 60}m`;
                                return `${minutes}m`;
                            })()}
                        </div>
                    </div>
                </div>

                {/* Tabs */}
                <div style={{
                    display: 'flex',
                    borderBottom: '1px solid var(--bg-border)',
                    background: 'rgba(0,0,0,0.2)'
                }}>
                    <button
                        onClick={() => setActiveTab('activity')}
                        style={{
                            flex: 1,
                            padding: '14px 20px',
                            background: 'transparent',
                            border: 'none',
                            borderBottom: activeTab === 'activity' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                            color: activeTab === 'activity' ? 'var(--text-primary)' : 'var(--text-muted)',
                            fontSize: '0.8rem',
                            fontWeight: '600',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}
                    >
                        Activity Log
                    </button>
                    <button
                        onClick={() => setActiveTab('algorithm')}
                        style={{
                            flex: 1,
                            padding: '14px 20px',
                            background: 'transparent',
                            border: 'none',
                            borderBottom: activeTab === 'algorithm' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                            color: activeTab === 'algorithm' ? 'var(--text-primary)' : 'var(--text-muted)',
                            fontSize: '0.8rem',
                            fontWeight: '600',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px'
                        }}
                    >
                        Algorithm
                    </button>
                </div>

                {/* Tab Content */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
                    {activeTab === 'activity' && (
                        <>
                            {tradesLoading ? (
                                <div style={{
                                    padding: '40px 20px',
                                    textAlign: 'center',
                                    color: 'var(--text-muted)',
                                    fontSize: '0.875rem'
                                }}>
                                    Loading trades...
                                </div>
                            ) : agentLogs.length === 0 ? (
                                <div style={{
                                    padding: '40px 20px',
                                    textAlign: 'center',
                                    color: 'var(--text-subtle)',
                                    fontSize: '0.875rem'
                                }}>
                                    No activity recorded yet.
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    {agentLogs.slice(0, 20).map((log, i) => (
                                        <div key={i} style={{
                                            padding: '14px 24px',
                                            borderBottom: '1px solid var(--bg-border)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '12px'
                                        }}>
                                            {log.action && (
                                                <span style={{
                                                    padding: '4px 8px',
                                                    borderRadius: '4px',
                                                    fontSize: '0.65rem',
                                                    fontWeight: '700',
                                                    letterSpacing: '0.5px',
                                                    background: log.action === 'BUY' ? 'var(--profit)' : 'var(--loss)',
                                                    color: log.action === 'BUY' ? 'var(--bg-base)' : 'var(--text-primary)'
                                                }}>
                                                    {log.action}
                                                </span>
                                            )}
                                            <div style={{ flex: 1 }}>
                                                <span style={{
                                                    color: 'var(--text-secondary)',
                                                    fontSize: '0.85rem'
                                                }}>
                                                    {log.symbol || log.message || 'Trade executed'}
                                                </span>
                                                {log.price && (
                                                    <span style={{
                                                        marginLeft: '8px',
                                                        color: 'var(--text-muted)',
                                                        fontSize: '0.8rem'
                                                    }}>
                                                        @ ${log.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                    </span>
                                                )}
                                            </div>
                                            <span style={{
                                                color: 'var(--text-subtle)',
                                                fontSize: '0.75rem'
                                            }}>
                                                {log.timestamp ? new Date(log.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}

                    {activeTab === 'algorithm' && (
                        <div style={{ padding: '0' }}>
                            {codeLoading && (
                                <div style={{
                                    padding: '40px 20px',
                                    textAlign: 'center',
                                    color: 'var(--text-muted)',
                                    fontSize: '0.875rem'
                                }}>
                                    Loading algorithm...
                                </div>
                            )}

                            {codeError && (
                                <div style={{
                                    padding: '40px 20px',
                                    textAlign: 'center',
                                    color: 'var(--loss)',
                                    fontSize: '0.875rem'
                                }}>
                                    {codeError}
                                </div>
                            )}

                            {agentCode && !codeLoading && (
                                <div style={{
                                    position: 'relative'
                                }}>
                                    {/* Code header */}
                                    <div style={{
                                        padding: '12px 20px',
                                        background: 'var(--bg-elevated)',
                                        borderBottom: '1px solid var(--bg-border)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }}>
                                        <span style={{
                                            fontSize: '0.75rem',
                                            color: 'var(--text-muted)',
                                            fontFamily: 'monospace'
                                        }}>
                                            {agent.name}.py
                                        </span>
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText(agentCode);
                                            }}
                                            style={{
                                                background: 'var(--bg-surface)',
                                                border: '1px solid var(--bg-border)',
                                                color: 'var(--text-muted)',
                                                padding: '4px 10px',
                                                borderRadius: '4px',
                                                fontSize: '0.7rem',
                                                cursor: 'pointer',
                                                transition: 'all 0.2s'
                                            }}
                                            onMouseEnter={(e) => {
                                                e.currentTarget.style.background = 'var(--accent-primary)';
                                                e.currentTarget.style.color = 'var(--bg-base)';
                                            }}
                                            onMouseLeave={(e) => {
                                                e.currentTarget.style.background = 'var(--bg-surface)';
                                                e.currentTarget.style.color = 'var(--text-muted)';
                                            }}
                                        >
                                            Copy
                                        </button>
                                    </div>

                                    {/* Code content */}
                                    <pre style={{
                                        margin: 0,
                                        padding: '16px 20px',
                                        background: 'var(--bg-base)',
                                        color: 'var(--text-secondary)',
                                        fontSize: '0.75rem',
                                        lineHeight: '1.6',
                                        fontFamily: "'Fira Code', 'Monaco', 'Consolas', monospace",
                                        overflow: 'auto',
                                        maxHeight: '400px',
                                        whiteSpace: 'pre',
                                        tabSize: 4
                                    }}>
                                        <code>{agentCode}</code>
                                    </pre>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AgentDetailModal;
