const Leaderboard = ({ agents }) => {
    // Sort agents by equity descending
    const sortedAgents = [...(agents || [])].sort((a, b) => (b.equity || 0) - (a.equity || 0));

    return (
        <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div className="section-header" style={{ marginBottom: '16px' }}>
                <div className="section-title">Leaderboard</div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ borderBottom: '1px solid var(--bg-border)' }}>
                            <th style={{
                                padding: '12px 8px',
                                textAlign: 'left',
                                fontSize: '0.7rem',
                                fontWeight: '600',
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px'
                            }}>Rank</th>
                            <th style={{
                                padding: '12px 8px',
                                textAlign: 'left',
                                fontSize: '0.7rem',
                                fontWeight: '600',
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px'
                            }}>Agent</th>
                            <th style={{
                                padding: '12px 8px',
                                textAlign: 'right',
                                fontSize: '0.7rem',
                                fontWeight: '600',
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px'
                            }}>Equity</th>
                            <th style={{
                                padding: '12px 8px',
                                textAlign: 'right',
                                fontSize: '0.7rem',
                                fontWeight: '600',
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px'
                            }}>P&L</th>
                            <th style={{
                                padding: '12px 8px',
                                textAlign: 'right',
                                fontSize: '0.7rem',
                                fontWeight: '600',
                                color: 'var(--text-muted)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px'
                            }}>ROI</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sortedAgents.map((agent, index) => {
                            const pnl = (agent.equity || 10000) - 10000;
                            const roi = agent.roi || (pnl / 10000 * 100);
                            const isProfit = roi >= 0;

                            return (
                                <tr
                                    key={agent.name}
                                    style={{
                                        borderBottom: '1px solid var(--bg-border)',
                                        transition: 'background 0.2s'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(31, 41, 55, 0.3)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                >
                                    <td style={{
                                        padding: '14px 8px',
                                        fontSize: '0.85rem',
                                        color: 'var(--text-muted)'
                                    }}>
                                        <span style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            width: '24px',
                                            height: '24px',
                                            borderRadius: '6px',
                                            background: index === 0 ? 'var(--warning)' :
                                                       index === 1 ? 'var(--text-muted)' :
                                                       index === 2 ? '#cd7f32' :
                                                       'var(--bg-elevated)',
                                            color: index < 3 ? 'var(--bg-base)' : 'var(--text-muted)',
                                            fontWeight: '700',
                                            fontSize: '0.75rem'
                                        }}>
                                            {index + 1}
                                        </span>
                                    </td>
                                    <td style={{
                                        padding: '14px 8px',
                                        fontWeight: '600',
                                        fontSize: '0.9rem',
                                        color: 'var(--text-primary)'
                                    }}>
                                        {agent.name}
                                    </td>
                                    <td style={{
                                        padding: '14px 8px',
                                        textAlign: 'right',
                                        fontSize: '0.9rem',
                                        fontWeight: '500',
                                        color: 'var(--text-primary)'
                                    }}>
                                        ${(agent.equity || 10000).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </td>
                                    <td style={{
                                        padding: '14px 8px',
                                        textAlign: 'right',
                                        fontSize: '0.9rem',
                                        fontWeight: '600',
                                        color: isProfit ? 'var(--profit)' : 'var(--loss)'
                                    }}>
                                        {isProfit ? '+' : ''}${pnl.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </td>
                                    <td style={{ padding: '14px 8px', textAlign: 'right' }}>
                                        <span className={`badge ${isProfit ? 'badge-profit' : 'badge-loss'}`}>
                                            {isProfit ? '+' : ''}{roi.toFixed(2)}%
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                        {sortedAgents.length === 0 && (
                            <tr>
                                <td colSpan="5" style={{
                                    textAlign: 'center',
                                    padding: '40px 20px',
                                    color: 'var(--text-muted)',
                                    fontSize: '0.875rem'
                                }}>
                                    No agents deployed yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default Leaderboard;
