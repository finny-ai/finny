const TradeLog = ({ logs }) => {
    return (
        <div style={{ flex: 1, overflowY: 'auto', fontSize: '0.85rem' }}>
            {logs.map((log, index) => (
                <div key={index} style={{
                    padding: '12px 0',
                    borderBottom: '1px solid var(--bg-border)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px'
                }}>
                    {/* Action Badge */}
                    <span style={{
                        padding: '4px 10px',
                        borderRadius: '6px',
                        fontSize: '0.7rem',
                        fontWeight: '700',
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                        background: log.action === 'BUY' ? 'var(--profit)' : 'var(--loss)',
                        color: log.action === 'BUY' ? 'var(--bg-base)' : 'var(--text-primary)',
                        minWidth: '40px',
                        textAlign: 'center'
                    }}>
                        {log.action}
                    </span>

                    {/* Symbol and Agent */}
                    <div style={{ flex: 1 }}>
                        <div style={{
                            fontWeight: '600',
                            color: 'var(--text-primary)',
                            fontSize: '0.9rem'
                        }}>
                            {log.symbol || 'BTC'}
                        </div>
                        <div style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)'
                        }}>
                            {log.agent || log.agent_id || log.agent_name || 'Unknown'}
                        </div>
                    </div>

                    {/* Price and Time */}
                    <div style={{ textAlign: 'right' }}>
                        <div style={{
                            fontWeight: '600',
                            color: 'var(--text-primary)',
                            fontSize: '0.9rem'
                        }}>
                            ${log.price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)'
                        }}>
                            {log.timestamp ? new Date(log.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                        </div>
                    </div>
                </div>
            ))}
            {logs.length === 0 && (
                <div style={{
                    textAlign: 'center',
                    padding: '30px 20px',
                    color: 'var(--text-muted)',
                    fontSize: '0.875rem'
                }}>
                    Waiting for trades...
                </div>
            )}
        </div>
    );
};

export default TradeLog;
