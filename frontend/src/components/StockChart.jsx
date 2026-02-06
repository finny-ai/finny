import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';

const StockChart = ({ data, symbol, color = '#10b981' }) => {
    // Determine color from CSS variable or direct hex
    const chartColor = useMemo(() => {
        if (color.startsWith('var(')) {
            // Map CSS variables to hex colors
            const colorMap = {
                'var(--profit)': '#10b981',
                'var(--loss)': '#ef4444',
                'var(--profit-light)': '#34d399',
                'var(--loss-light)': '#f87171',
            };
            return colorMap[color] || '#10b981';
        }
        return color;
    }, [color]);

    // Determine min/max for better axis scaling
    const { minPrice, maxPrice } = useMemo(() => {
        if (!data || data.length === 0) return { minPrice: 0, maxPrice: 100 };
        const prices = data.map(d => d.price);
        return {
            minPrice: Math.min(...prices) * 0.999,
            maxPrice: Math.max(...prices) * 1.001
        };
    }, [data]);

    // Custom tooltip
    const CustomTooltip = ({ active, payload }) => {
        if (!active || !payload || payload.length === 0) return null;

        return (
            <div style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--bg-border)',
                borderRadius: '6px',
                padding: '8px 12px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                fontSize: '0.8rem'
            }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: '600' }}>
                    ${payload[0].value?.toFixed(2)}
                </div>
            </div>
        );
    };

    if (!data || data.length === 0) {
        return (
            <div style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                fontSize: '0.75rem'
            }}>
                No data
            </div>
        );
    }

    return (
        <div style={{ width: '100%', height: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                        <linearGradient id={`gradient-${symbol}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={chartColor} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={chartColor} stopOpacity={0.05} />
                        </linearGradient>
                    </defs>

                    <XAxis
                        dataKey="time"
                        type="number"
                        domain={['dataMin', 'dataMax']}
                        hide={true}
                    />

                    <YAxis
                        domain={[minPrice, maxPrice]}
                        hide={true}
                    />

                    <Tooltip content={<CustomTooltip />} />

                    <Area
                        type="monotone"
                        dataKey="price"
                        stroke={chartColor}
                        strokeWidth={2}
                        fillOpacity={1}
                        fill={`url(#gradient-${symbol})`}
                        isAnimationActive={false}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
};

export default StockChart;
