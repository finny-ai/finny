import React, { useState, useEffect } from 'react';
import { api } from '../api';

const AGENT_COLORS = ['#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const UserDetailModal = ({ user, onClose, onSelectAgent }) => {
    const [agents, setAgents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    if (!user) return null;

    useEffect(() => {
        setLoading(true);
        setError(null);

        api.get(`/user/${user.username}/agents`)
            .then(res => {
                setAgents(res.data.agents || []);
                setLoading(false);
            })
            .catch(err => {
                console.log('User agents fetch error:', err);
                setError(err.response?.data?.error || 'Failed to load user agents');
                setLoading(false);
            });
    }, [user.username]);

    const isProfit = (user.weighted_roi || 0) >= 0;

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
                width: '600px',
                maxHeight: '80vh',
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
                            fontWeight: '700',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px'
                        }}>
                            <span style={{
                                width: '32px',
                                height: '32px',
                                borderRadius: '50%',
                                background: 'linear-gradient(135deg, var(--accent-primary), #8b5cf6)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.9rem',
                                fontWeight: '600',
                                color: 'var(--bg-base)'
                            }}>
                                {user.username.charAt(0).toUpperCase()}
                            </span>
                            {user.username}
                        </h2>
                        <span style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '1px'
                        }}>Algorithm Developer</span>
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
                        x
                    </button>
                </div>

                {/* Stats Grid */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
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
                        }}>Total Equity</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: 'var(--text-primary)'
                        }}>
                            ${(user.total_equity || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
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
                        }}>Weighted ROI</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: isProfit ? 'var(--profit)' : 'var(--loss)'
                        }}>
                            {isProfit ? '+' : ''}{(user.weighted_roi || 0).toFixed(2)}%
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
                        }}>Strategies</div>
                        <div style={{
                            fontSize: '1.25rem',
                            fontWeight: '700',
                            color: 'var(--text-primary)'
                        }}>
                            {user.strategy_count || 0}
                        </div>
                    </div>
                </div>

                {/* Section Header */}
                <div style={{
                    padding: '16px 24px',
                    borderTop: '1px solid var(--bg-border)',
                    borderBottom: '1px solid var(--bg-border)',
                    background: 'rgba(0,0,0,0.2)'
                }}>
                    <span style={{
                        fontSize: '0.8rem',
                        fontWeight: '600',
                        color: 'var(--text-primary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px'
                    }}>Deployed Algorithms</span>
                </div>

                {/* Agents List */}
                <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
                    {loading ? (
                        <div style={{
                            padding: '40px 20px',
                            textAlign: 'center',
                            color: 'var(--text-muted)',
                            fontSize: '0.875rem'
                        }}>
                            Loading algorithms...
                        </div>
                    ) : error ? (
                        <div style={{
                            padding: '40px 20px',
                            textAlign: 'center',
                            color: 'var(--loss)',
                            fontSize: '0.875rem'
                        }}>
                            {error}
                        </div>
                    ) : agents.length === 0 ? (
                        <div style={{
                            padding: '40px 20px',
                            textAlign: 'center',
                            color: 'var(--text-subtle)',
                            fontSize: '0.875rem'
                        }}>
                            No algorithms deployed yet.
                        </div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            {agents.map((agent, index) => {
                                const roi = agent.roi || 0;
                                const agentIsProfit = roi >= 0;
                                const color = AGENT_COLORS[index % AGENT_COLORS.length];

                                return (
                                    <div
                                        key={agent.name}
                                        onClick={() => onSelectAgent && onSelectAgent(agent)}
                                        style={{
                                            padding: '16px 24px',
                                            borderBottom: '1px solid var(--bg-border)',
                                            cursor: 'pointer',
                                            transition: 'background 0.2s',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '16px'
                                        }}
                                        onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(31, 41, 55, 0.5)'}
                                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                    >
                                        {/* Color indicator */}
                                        <span style={{
                                            width: '4px',
                                            height: '40px',
                                            borderRadius: '2px',
                                            background: color
                                        }}></span>

                                        {/* Agent info */}
                                        <div style={{ flex: 1 }}>
                                            <div style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '10px',
                                                marginBottom: '4px'
                                            }}>
                                                <span style={{
                                                    fontWeight: '600',
                                                    color: 'var(--text-primary)',
                                                    fontSize: '0.95rem'
                                                }}>{agent.name}</span>
                                                <span style={{
                                                    fontSize: '0.7rem',
                                                    color: 'var(--accent-primary)',
                                                    background: 'rgba(16, 185, 129, 0.15)',
                                                    padding: '2px 8px',
                                                    borderRadius: '4px',
                                                    fontWeight: '600'
                                                }}>{agent.symbol}</span>
                                            </div>
                                            <div style={{
                                                fontSize: '0.75rem',
                                                color: 'var(--text-muted)'
                                            }}>
                                                {agent.trades || 0} trades
                                            </div>
                                        </div>

                                        {/* Equity and ROI */}
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{
                                                fontSize: '1.1rem',
                                                fontWeight: '700',
                                                color: 'var(--text-primary)',
                                                marginBottom: '4px'
                                            }}>
                                                ${(agent.equity || 10000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                            </div>
                                            <span className={`badge ${agentIsProfit ? 'badge-profit' : 'badge-loss'}`}>
                                                {agentIsProfit ? '+' : ''}{roi.toFixed(2)}%
                                            </span>
                                        </div>

                                        {/* Arrow indicator */}
                                        <span style={{
                                            color: 'var(--text-muted)',
                                            fontSize: '1rem'
                                        }}></span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default UserDetailModal;
