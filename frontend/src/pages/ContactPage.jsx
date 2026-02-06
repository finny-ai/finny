import React from 'react';
import { Link } from 'react-router-dom';

const ContactPage = () => {
    return (
        <div style={{
            minHeight: '100vh',
            background: 'var(--bg-base)',
            padding: '40px 20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center'
        }}>
            {/* Header */}
            <header style={{
                width: '100%',
                maxWidth: '800px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '60px'
            }}>
                <Link to="/" style={{
                    fontSize: '1.25rem',
                    fontWeight: '700',
                    color: 'var(--text-primary)',
                    textDecoration: 'none'
                }}>
                    AlgoClash
                </Link>
                <nav style={{ display: 'flex', gap: '24px' }}>
                    <Link to="/dashboard" className="nav-link">Dashboard</Link>
                    <Link to="/leaderboard" className="nav-link">Leaderboard</Link>
                    <Link to="/contact" className="nav-link active">Contact</Link>
                </nav>
            </header>

            {/* Content */}
            <div style={{
                width: '100%',
                maxWidth: '600px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--bg-border)',
                borderRadius: '16px',
                padding: '48px',
                textAlign: 'center'
            }}>
                <h1 style={{
                    fontSize: '2rem',
                    fontWeight: '700',
                    color: 'var(--text-primary)',
                    marginBottom: '8px'
                }}>
                    Get in Touch
                </h1>
                <p style={{
                    fontSize: '1rem',
                    color: 'var(--text-muted)',
                    marginBottom: '12px',
                    lineHeight: '1.6'
                }}>
                    Built by Jaimin Patel at the University of Waterloo.
                </p>
                <p style={{
                    fontSize: '0.9rem',
                    color: 'var(--text-subtle)',
                    marginBottom: '40px',
                    lineHeight: '1.6'
                }}>
                    Whether you want to collaborate, report a bug, or just talk algo trading
                    — I'm always down to chat.
                </p>

                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '16px'
                }}>
                    {/* Email */}
                    <a
                        href="mailto:jk22pate@uwaterloo.ca?subject=AlgoClash%20—%20Let's%20Talk"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '12px',
                            padding: '16px 24px',
                            background: 'var(--accent-primary)',
                            color: 'var(--bg-base)',
                            borderRadius: '8px',
                            textDecoration: 'none',
                            fontWeight: '600',
                            fontSize: '1rem',
                            transition: 'opacity 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.opacity = '0.9'}
                        onMouseLeave={(e) => e.currentTarget.style.opacity = '1'}
                    >
                        <span style={{ fontSize: '1.2rem' }}>@</span>
                        jk22pate@uwaterloo.ca
                    </a>

                    {/* Twitter/X */}
                    <a
                        href="https://x.com/JaiminPate25520"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '12px',
                            padding: '16px 24px',
                            background: 'var(--bg-elevated)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--bg-border)',
                            borderRadius: '8px',
                            textDecoration: 'none',
                            fontWeight: '600',
                            fontSize: '1rem',
                            transition: 'background 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-border)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    >
                        <span style={{ fontWeight: '800' }}>X</span>
                        @JaiminPate25520
                    </a>

                    {/* GitHub */}
                    <a
                        href="https://github.com/Jaiminp007/finny"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '12px',
                            padding: '16px 24px',
                            background: 'var(--bg-elevated)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--bg-border)',
                            borderRadius: '8px',
                            textDecoration: 'none',
                            fontWeight: '600',
                            fontSize: '1rem',
                            transition: 'background 0.2s'
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-border)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'var(--bg-elevated)'}
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                        </svg>
                        Jaiminp007/finny
                    </a>
                </div>

                <div style={{
                    marginTop: '40px',
                    padding: '20px',
                    background: 'rgba(16, 185, 129, 0.08)',
                    borderRadius: '8px',
                    border: '1px solid rgba(16, 185, 129, 0.15)'
                }}>
                    <p style={{
                        fontSize: '0.85rem',
                        color: 'var(--text-secondary)',
                        lineHeight: '1.6',
                        margin: 0
                    }}>
                        AlgoClash is an open-source algorithmic trading arena where your
                        strategies compete in real-time against live market data. Deploy code,
                        watch it trade, climb the leaderboard.
                    </p>
                </div>
            </div>
        </div>
    );
};

export default ContactPage;
