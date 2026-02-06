import { useState, useEffect } from 'react';
import { socket, api } from '../api';
import { Link } from 'react-router-dom';
import { FaArrowLeft } from 'react-icons/fa';
import UserDetailModal from '../components/UserDetailModal';
import AgentDetailModal from '../components/AgentDetailModal';

const LeaderboardPage = () => {
    const [agents, setAgents] = useState([]);
    const [users, setUsers] = useState([]);
    const [viewMode, setViewMode] = useState('users'); // 'users' or 'agents'
    const [selectedUser, setSelectedUser] = useState(null);
    const [selectedAgent, setSelectedAgent] = useState(null);
    const [logs, setLogs] = useState([]);

    useEffect(() => {
        // Request immediate update
        if (socket.connected) {
            socket.emit('request_history'); // Triggers bundle usually
        }

        // Fetch user leaderboard
        api.get('/users/leaderboard')
            .then(res => {
                setUsers(res.data.leaderboard || []);
            })
            .catch(err => {
                console.log('User leaderboard fetch error:', err);
            });

        const handleUpdate = (data) => {
            setAgents(data);
        };

        const handleBundle = (bundle) => {
            if (bundle.leaderboard) {
                setAgents(bundle.leaderboard);
            }
            if (bundle.users) {
                setUsers(bundle.users);
            }
        };

        socket.on('leaderboard_update', handleUpdate);
        socket.on('tick_bundle', handleBundle);

        return () => {
            socket.off('leaderboard_update', handleUpdate);
            socket.off('tick_bundle', handleBundle);
        };
    }, []);

    // Handle agent selection from UserDetailModal
    const handleAgentFromUser = (agent) => {
        setSelectedUser(null);
        setSelectedAgent(agent);
    };

    // Calculate Sharpe Ratio (simplified)
    // In a real app, this would be computed backend based on historical volatility
    const getSharpe = (roi) => {
        if (!roi) return "0.00";
        // Mock calc: ROI / Volatility (assumed constant for mock)
        return (roi / 5).toFixed(2);
    };

    return (
        <div className="leaderboard-page fade-in" style={{ padding: '40px', maxWidth: '1200px', margin: '0 auto', color: 'var(--text-primary)' }}>
            {/* Agent Modal */}
            {selectedAgent && (
                <AgentDetailModal
                    agent={selectedAgent}
                    onClose={() => setSelectedAgent(null)}
                    logs={logs}
                />
            )}

            {/* User Modal */}
            {selectedUser && (
                <UserDetailModal
                    user={selectedUser}
                    onClose={() => setSelectedUser(null)}
                    onSelectAgent={handleAgentFromUser}
                />
            )}

            <header style={{ display: 'flex', alignItems: 'center', marginBottom: '40px' }}>
                <Link to="/dashboard" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--accent-blue)', textDecoration: 'none', fontSize: '1.2rem', fontWeight: 'bold' }}>
                    <FaArrowLeft /> Back to Dashboard
                </Link>
                <div className="logo" style={{ marginLeft: 'auto', fontSize: '2rem' }}>ALGO<span style={{ color: 'var(--accent-orange)' }}>CLASH</span> LEADERBOARD</div>
            </header>

            {/* View Toggle */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
                <button
                    onClick={() => setViewMode('users')}
                    style={{
                        padding: '10px 24px',
                        fontSize: '0.9rem',
                        fontWeight: '600',
                        borderRadius: '8px',
                        border: viewMode === 'users' ? 'none' : '1px solid var(--bg-border)',
                        cursor: 'pointer',
                        background: viewMode === 'users' ? 'var(--accent-primary)' : 'var(--bg-surface)',
                        color: viewMode === 'users' ? 'var(--bg-base)' : 'var(--text-muted)',
                        transition: 'all 0.2s'
                    }}
                >
                    Users
                </button>
                <button
                    onClick={() => setViewMode('agents')}
                    style={{
                        padding: '10px 24px',
                        fontSize: '0.9rem',
                        fontWeight: '600',
                        borderRadius: '8px',
                        border: viewMode === 'agents' ? 'none' : '1px solid var(--bg-border)',
                        cursor: 'pointer',
                        background: viewMode === 'agents' ? 'var(--accent-primary)' : 'var(--bg-surface)',
                        color: viewMode === 'agents' ? 'var(--bg-base)' : 'var(--text-muted)',
                        transition: 'all 0.2s'
                    }}
                >
                    Agents
                </button>
            </div>

            <div className="glass-panel" style={{ padding: '20px', overflowX: 'auto', display: 'flex', flexDirection: 'column' }}>
                {viewMode === 'users' ? (
                    // User Leaderboard
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                                <th style={{ padding: '15px' }}>Rank</th>
                                <th style={{ padding: '15px' }}>Username</th>
                                <th style={{ padding: '15px', textAlign: 'right' }}>Total Equity ($)</th>
                                <th style={{ padding: '15px', textAlign: 'right' }}>Weighted ROI (%)</th>
                                <th style={{ padding: '15px', textAlign: 'right' }}># Strategies</th>
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((user, index) => (
                                <tr
                                    key={user.username}
                                    className="leaderboard-row"
                                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
                                    onClick={() => setSelectedUser(user)}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(31, 41, 55, 0.5)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                >
                                    <td style={{ padding: '15px', fontWeight: 'bold', color: index === 0 ? '#ffd700' : index === 1 ? '#c0c0c0' : index === 2 ? '#cd7f32' : 'inherit' }}>
                                        #{index + 1}
                                    </td>
                                    <td style={{ padding: '15px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <span style={{
                                            width: '28px',
                                            height: '28px',
                                            borderRadius: '50%',
                                            background: 'linear-gradient(135deg, #10b981, #8b5cf6)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            fontSize: '0.8rem',
                                            fontWeight: '600',
                                            color: 'var(--bg-base)'
                                        }}>
                                            {user.username.charAt(0).toUpperCase()}
                                        </span>
                                        {user.username}
                                    </td>
                                    <td style={{ padding: '15px', textAlign: 'right', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                                        ${(user.total_equity || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td style={{ padding: '15px', textAlign: 'right', color: (user.weighted_roi || 0) >= 0 ? '#00c853' : '#d50000', fontWeight: 'bold' }}>
                                        {(user.weighted_roi || 0) >= 0 ? '+' : ''}{(user.weighted_roi || 0).toFixed(2)}%
                                    </td>
                                    <td style={{ padding: '15px', textAlign: 'right', fontFamily: 'monospace' }}>
                                        {user.strategy_count || 0}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    // Agent Leaderboard
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                            <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                                <th style={{ padding: '15px' }}>Rank</th>
                                <th style={{ padding: '15px' }}>Agent Name</th>
                                <th style={{ padding: '15px' }}>Owner</th>
                                <th style={{ padding: '15px' }}>Symbol</th>
                                <th style={{ padding: '15px', textAlign: 'right' }}>Equity ($)</th>
                                <th style={{ padding: '15px', textAlign: 'right' }}>ROI (%)</th>
                                <th style={{ padding: '15px', textAlign: 'right' }}>Trades</th>
                            </tr>
                        </thead>
                        <tbody>
                            {agents.map((agent, index) => (
                                <tr
                                    key={agent.name}
                                    className="leaderboard-row"
                                    style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', cursor: 'pointer' }}
                                    onClick={() => setSelectedAgent(agent)}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(31, 41, 55, 0.5)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                >
                                    <td style={{ padding: '15px', fontWeight: 'bold', color: index === 0 ? '#ffd700' : index === 1 ? '#c0c0c0' : index === 2 ? '#cd7f32' : 'inherit' }}>
                                        #{index + 1}
                                    </td>
                                    <td style={{ padding: '15px', fontWeight: '500' }}>{agent.name}</td>
                                    <td style={{ padding: '15px', color: 'var(--text-muted)' }}>{agent.username || 'anonymous'}</td>
                                    <td style={{ padding: '15px' }}>
                                        <span style={{
                                            fontSize: '0.75rem',
                                            color: 'var(--accent-primary)',
                                            background: 'rgba(16, 185, 129, 0.15)',
                                            padding: '3px 8px',
                                            borderRadius: '4px',
                                            fontWeight: '600'
                                        }}>{agent.symbol}</span>
                                    </td>
                                    <td style={{ padding: '15px', textAlign: 'right', fontFamily: 'monospace', fontSize: '1.1rem' }}>
                                        ${(agent.equity || 0).toFixed(2)}
                                    </td>
                                    <td style={{ padding: '15px', textAlign: 'right', color: (agent.roi || 0) >= 0 ? '#00c853' : '#d50000', fontWeight: 'bold' }}>
                                        {(agent.roi || 0) >= 0 ? '+' : ''}{(agent.roi || 0).toFixed(2)}%
                                    </td>
                                    <td style={{ padding: '15px', textAlign: 'right', fontFamily: 'monospace' }}>
                                        {agent.trades || 0}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {viewMode === 'users' && users.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>No users found. Deploy strategies to see user rankings.</div>}
                {viewMode === 'agents' && agents.length === 0 && <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>Waiting for market data...</div>}
            </div>
        </div>
    );
};

export default LeaderboardPage;
