import React from 'react';

const NewsFeed = ({ news }) => {
    // Get sentiment color based on score
    const getSentimentColor = (sentiment) => {
        if (sentiment > 0.2) return 'var(--profit)';
        if (sentiment < -0.2) return 'var(--loss)';
        return 'var(--warning)';
    };

    // Get sentiment label
    const getSentimentLabel = (sentiment) => {
        if (sentiment > 0.5) return 'Very Bullish';
        if (sentiment > 0.2) return 'Bullish';
        if (sentiment < -0.5) return 'Very Bearish';
        if (sentiment < -0.2) return 'Bearish';
        return 'Neutral';
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'hidden' }}>
            {news.length === 0 ? (
                <div style={{
                    color: 'var(--text-muted)',
                    padding: '20px',
                    textAlign: 'center',
                    fontSize: '0.875rem'
                }}>
                    Waiting for headlines...
                </div>
            ) : (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                    overflowY: 'auto',
                    paddingRight: '5px'
                }}>
                    {news.map((item, index) => {
                        const sentimentColor = getSentimentColor(item.sentiment);
                        return (
                            <div key={index} style={{
                                padding: '12px',
                                borderRadius: '8px',
                                background: 'rgba(17, 24, 39, 0.5)',
                                borderLeft: `3px solid ${sentimentColor}`,
                                transition: 'background 0.2s'
                            }}>
                                <div style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '6px'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <span style={{
                                            fontSize: '0.7rem',
                                            fontWeight: '600',
                                            color: 'var(--text-muted)',
                                            textTransform: 'uppercase',
                                            letterSpacing: '0.5px'
                                        }}>
                                            {item.symbol || 'MARKET'}
                                        </span>
                                        <span style={{
                                            fontSize: '0.65rem',
                                            padding: '2px 6px',
                                            borderRadius: '4px',
                                            background: `${sentimentColor}20`,
                                            color: sentimentColor,
                                            fontWeight: '500'
                                        }}>
                                            {getSentimentLabel(item.sentiment)}
                                        </span>
                                    </div>
                                    <span style={{
                                        fontSize: '0.7rem',
                                        color: 'var(--text-subtle)'
                                    }}>
                                        {item.timestamp ? new Date(item.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                    </span>
                                </div>
                                <div style={{
                                    fontSize: '0.85rem',
                                    lineHeight: '1.4',
                                    color: 'var(--text-secondary)'
                                }}>
                                    {item.title}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default NewsFeed;
