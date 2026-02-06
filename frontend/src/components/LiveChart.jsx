import { useMemo } from 'react';
import { ResponsiveContainer, LineChart, XAxis, YAxis, Tooltip, CartesianGrid, Line, ReferenceLine, Legend } from 'recharts';

// Midnight Terminal Agent Colors
const AGENT_COLORS = ['#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];

const LiveChart = ({ data, agents, users, timeRange = 'ALL', viewMode = 'agents' }) => {
    // Determine which entities to display based on viewMode
    const entities = viewMode === 'users' ? (users || []) : (agents || []);
    const entityKey = viewMode === 'users' ? 'username' : 'name';
    // Filter data based on time range
    const filteredData = useMemo(() => {
        if (timeRange === 'ALL' || data.length === 0) return data;

        const now = Date.now() / 1000;
        const ranges = {
            '1H': 3600,
            '4H': 14400,
            '1D': 86400
        };
        const cutoff = now - (ranges[timeRange] || Infinity);
        return data.filter(d => d.time >= cutoff);
    }, [data, timeRange]);

    // Calculate dynamic Y-axis domain based on actual entity values
    // IMPORTANT: Always include $10,000 baseline to show the starting point
    const yDomain = useMemo(() => {
        if (filteredData.length === 0 || entities.length === 0) {
            return [9000, 11000]; // Default range around $10,000
        }

        let minVal = Infinity;
        let maxVal = -Infinity;

        // Find min/max across all entity values in the filtered data
        filteredData.forEach(point => {
            entities.forEach(entity => {
                const key = entity[entityKey];
                const val = point[key];
                if (val !== undefined && val !== null) {
                    minVal = Math.min(minVal, val);
                    maxVal = Math.max(maxVal, val);
                }
            });
        });

        // If no valid data found, use default
        if (minVal === Infinity || maxVal === -Infinity) {
            return [9000, 11000];
        }

        // Always include 10000 (starting equity) in the range
        minVal = Math.min(minVal, 10000);
        maxVal = Math.max(maxVal, 10000);

        // Add 5% padding on each side for better visualization
        const range = maxVal - minVal;
        const padding = Math.max(range * 0.05, 100); // At least $100 padding

        return [
            Math.floor((minVal - padding) / 100) * 100, // Round down to nearest 100
            Math.ceil((maxVal + padding) / 100) * 100   // Round up to nearest 100
        ];
    }, [filteredData, entities, entityKey]);

    // Check if $10,000 baseline is within the current view
    const showBaseline = yDomain[0] <= 10000 && yDomain[1] >= 10000;

    // Custom tooltip styling
    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload || payload.length === 0) return null;

        return (
            <div style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--bg-border)',
                borderRadius: '8px',
                padding: '12px',
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)'
            }}>
                <div style={{
                    color: 'var(--text-muted)',
                    fontSize: '0.75rem',
                    marginBottom: '8px',
                    borderBottom: '1px solid var(--bg-border)',
                    paddingBottom: '8px'
                }}>
                    {new Date(label * 1000).toLocaleTimeString()}
                </div>
                {payload.map((entry, index) => (
                    <div key={index} style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '16px',
                        padding: '4px 0',
                        fontSize: '0.8rem'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: entry.color
                            }}></span>
                            <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
                        </div>
                        <span style={{ color: 'var(--text-primary)', fontWeight: '600' }}>
                            ${entry.value?.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                        </span>
                    </div>
                ))}
            </div>
        );
    };

    // Custom legend
    const CustomLegend = ({ payload }) => {
        return (
            <div style={{
                display: 'flex',
                gap: '20px',
                justifyContent: 'flex-start',
                paddingTop: '12px',
                paddingLeft: '60px'
            }}>
                {payload.map((entry, index) => (
                    <div key={index} style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '0.8rem'
                    }}>
                        <span style={{
                            width: '10px',
                            height: '10px',
                            borderRadius: '50%',
                            background: entry.color
                        }}></span>
                        <span style={{ color: 'var(--text-secondary)' }}>{entry.value}</span>
                    </div>
                ))}
            </div>
        );
    };

    // Format Y-axis tick based on value magnitude
    const formatYTick = (val) => {
        if (val >= 1000) {
            return `$${(val / 1000).toFixed(1)}k`;
        }
        return `$${val}`;
    };

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: '250px', position: 'relative' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={filteredData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                        <defs>
                            {AGENT_COLORS.map((color, index) => (
                                <linearGradient key={index} id={`line-gradient-${index}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                                </linearGradient>
                            ))}
                        </defs>

                        <CartesianGrid
                            strokeDasharray="3 3"
                            stroke="var(--bg-border)"
                            vertical={false}
                            opacity={0.5}
                        />

                        <XAxis
                            dataKey="time"
                            type="number"
                            domain={['dataMin', 'dataMax']}
                            tickFormatter={(unix) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            stroke="var(--bg-border)"
                            fontSize={10}
                            tick={{ fill: 'var(--text-muted)' }}
                            axisLine={{ stroke: 'var(--bg-border)' }}
                            tickLine={{ stroke: 'var(--bg-border)' }}
                        />

                        <YAxis
                            yAxisId="left"
                            orientation="left"
                            domain={yDomain}
                            stroke="var(--bg-border)"
                            width={60}
                            fontSize={10}
                            tick={{ fill: 'var(--text-muted)' }}
                            tickFormatter={formatYTick}
                            axisLine={{ stroke: 'var(--bg-border)' }}
                            tickLine={{ stroke: 'var(--bg-border)' }}
                            allowDataOverflow={false}
                        />

                        <Tooltip content={<CustomTooltip />} />
                        <Legend content={<CustomLegend />} />

                        {/* Baseline at 10000 - only show if in view */}
                        {showBaseline && (
                            <ReferenceLine
                                y={10000}
                                yAxisId="left"
                                stroke="var(--text-subtle)"
                                strokeDasharray="3 3"
                                label={{
                                    value: 'START ($10,000)',
                                    position: 'insideTopLeft',
                                    fill: 'var(--text-subtle)',
                                    fontSize: 10
                                }}
                            />
                        )}

                        {/* Entity Lines (Agents or Users) */}
                        {entities.map((entity, index) => {
                            const color = AGENT_COLORS[index % AGENT_COLORS.length];
                            const key = entity[entityKey];
                            return (
                                <Line
                                    key={key}
                                    yAxisId="left"
                                    type="monotone"
                                    dataKey={key}
                                    stroke={color}
                                    strokeWidth={2.5}
                                    dot={false}
                                    activeDot={{
                                        r: 6,
                                        stroke: color,
                                        strokeWidth: 2,
                                        fill: 'var(--bg-surface)'
                                    }}
                                    name={key}
                                    isAnimationActive={false}
                                    connectNulls={true}
                                />
                            );
                        })}
                    </LineChart>
                </ResponsiveContainer>

                {/* No data overlay */}
                {filteredData.length === 0 && (
                    <div style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: 'var(--text-muted)',
                        fontSize: '0.875rem'
                    }}>
                        Waiting for chart data...
                    </div>
                )}
            </div>
        </div>
    );
};

export default LiveChart;
