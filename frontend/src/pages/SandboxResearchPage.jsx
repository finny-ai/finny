import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, socket } from '../api';

// ==================== Command Definitions ====================
const COMMANDS = [
    // Core Modes
    { cmd: '/plan', desc: 'Create a research plan (no code execution)', category: 'Modes', args: '<request>' },
    { cmd: '/approve', desc: 'Execute the plan - run research and show findings', category: 'Modes' },
    { cmd: '/build', desc: 'Build algorithm based on research findings', category: 'Modes' },
    { cmd: '/backtest', desc: 'Backtest algorithm against historical data', category: 'Modes', args: '--period <1m|3m|6m|1y> --initial <amount>' },

    // Research
    { cmd: '/research', desc: 'Deep research on a topic', category: 'Research', args: '<topic>' },
    { cmd: '/analyze', desc: 'Full analysis of a ticker', category: 'Research', args: '<ticker>' },
    { cmd: '/compare', desc: 'Compare two assets', category: 'Research', args: '<ticker1> <ticker2>' },
    { cmd: '/sentiment', desc: 'News sentiment analysis', category: 'Research', args: '<ticker>' },

    // Data
    { cmd: '/insider', desc: 'Show recent insider trades', category: 'Data', args: '<ticker>' },
    { cmd: '/institutional', desc: 'Institutional ownership changes', category: 'Data', args: '<ticker>' },
    { cmd: '/financials', desc: 'Financial statements', category: 'Data', args: '<ticker>' },
    { cmd: '/news', desc: 'Recent news with sentiment', category: 'Data', args: '<ticker>' },

    // Algorithm
    { cmd: '/deploy', desc: 'Deploy algorithm to arena', category: 'Algorithm' },
    { cmd: '/optimize', desc: 'Optimize algorithm parameters', category: 'Algorithm' },
    { cmd: '/explain', desc: 'Explain current algorithm logic', category: 'Algorithm' },
    { cmd: '/code', desc: 'Show full algorithm code', category: 'Algorithm' },

    // Session
    { cmd: '/clear', desc: 'Clear conversation history', category: 'Session' },
    { cmd: '/model', desc: 'Switch AI model', category: 'Session', args: '<model-name>' },
    { cmd: '/status', desc: 'Show session status', category: 'Session' },
    { cmd: '/help', desc: 'Show all commands', category: 'Session' },
    { cmd: '/exit', desc: 'End session', category: 'Session' },
];

const TOOLS = [
    { name: 'Python', icon: '🐍', color: '#3776ab' },
    { name: 'Market Data', icon: '📊', color: '#10b981' },
    { name: 'News API', icon: '📰', color: '#f59e0b' },
    { name: 'Insider', icon: '🔍', color: '#8b5cf6' },
    { name: 'Institutional', icon: '🏦', color: '#06b6d4' },
];

// ==================== Terminal Output Components ====================

const TerminalLine = ({ type, content, timestamp }) => {
    const getPrefix = () => {
        switch (type) {
            case 'input': return <span style={{ color: '#22d3ee' }}>$ </span>;
            case 'system': return <span style={{ color: '#f59e0b' }}>⚡ </span>;
            case 'error': return <span style={{ color: '#ef4444' }}>✗ </span>;
            case 'success': return <span style={{ color: '#10b981' }}>✓ </span>;
            case 'info': return <span style={{ color: '#6b7280' }}>→ </span>;
            case 'thinking': return <span style={{ color: '#a78bfa' }}>🧠 </span>;
            case 'code': return null;
            case 'plan': return <span style={{ color: '#f59e0b' }}>📋 </span>;
            default: return null;
        }
    };

    if (type === 'code') {
        return (
            <div style={{
                background: '#0d1117',
                border: '1px solid #30363d',
                borderRadius: '6px',
                margin: '8px 0',
                overflow: 'hidden'
            }}>
                <div style={{
                    padding: '6px 12px',
                    background: '#161b22',
                    borderBottom: '1px solid #30363d',
                    fontSize: '0.7rem',
                    color: '#8b949e',
                    display: 'flex',
                    justifyContent: 'space-between'
                }}>
                    <span>python</span>
                    <span>{content.lines} lines</span>
                </div>
                <pre style={{
                    margin: 0,
                    padding: '12px',
                    fontSize: '0.8rem',
                    color: '#c9d1d9',
                    overflow: 'auto',
                    maxHeight: '300px'
                }}>
                    <code>{content.code}</code>
                </pre>
                {content.output && (
                    <div style={{
                        padding: '10px 12px',
                        background: 'rgba(16, 185, 129, 0.1)',
                        borderTop: '1px solid #30363d',
                        fontSize: '0.8rem',
                        color: '#10b981'
                    }}>
                        <pre style={{ margin: 0 }}>{content.output}</pre>
                    </div>
                )}
                {content.error && (
                    <div style={{
                        padding: '10px 12px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        borderTop: '1px solid #30363d',
                        fontSize: '0.8rem',
                        color: '#ef4444'
                    }}>
                        <pre style={{ margin: 0 }}>{content.error}</pre>
                    </div>
                )}
            </div>
        );
    }

    if (type === 'plan-box') {
        return (
            <div style={{
                background: 'rgba(245, 158, 11, 0.1)',
                border: '1px solid rgba(245, 158, 11, 0.3)',
                borderRadius: '6px',
                margin: '8px 0',
                padding: '12px',
                fontSize: '0.85rem'
            }}>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#fbbf24' }}>{content}</pre>
            </div>
        );
    }

    if (type === 'research-findings') {
        return (
            <div style={{
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                borderRadius: '6px',
                margin: '8px 0',
                padding: '12px',
                fontSize: '0.85rem'
            }}>
                <div style={{
                    fontWeight: '600',
                    color: '#10b981',
                    marginBottom: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                }}>
                    📊 Research Findings
                </div>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#9ca3af' }}>{content}</pre>
            </div>
        );
    }

    if (type === 'backtest-results') {
        return (
            <div style={{
                background: '#0d1117',
                border: '1px solid #30363d',
                borderRadius: '6px',
                margin: '8px 0',
                overflow: 'hidden'
            }}>
                <div style={{
                    padding: '8px 12px',
                    background: '#161b22',
                    borderBottom: '1px solid #30363d',
                    fontSize: '0.75rem',
                    color: '#8b949e'
                }}>
                    📈 Backtest Results
                </div>
                <div style={{ padding: '12px' }}>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: '12px',
                        marginBottom: '12px'
                    }}>
                        {content.metrics.map((m, i) => (
                            <div key={i} style={{
                                background: '#161b22',
                                padding: '10px',
                                borderRadius: '4px',
                                textAlign: 'center'
                            }}>
                                <div style={{ fontSize: '0.7rem', color: '#8b949e', marginBottom: '4px' }}>{m.label}</div>
                                <div style={{
                                    fontSize: '1rem',
                                    fontWeight: '600',
                                    color: m.color || '#c9d1d9'
                                }}>{m.value}</div>
                            </div>
                        ))}
                    </div>
                    {content.trades && (
                        <div style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                            <div style={{ marginBottom: '6px' }}>Recent Trades:</div>
                            {content.trades.slice(0, 5).map((t, i) => (
                                <div key={i} style={{
                                    display: 'flex',
                                    gap: '12px',
                                    padding: '4px 0',
                                    borderBottom: '1px solid #21262d'
                                }}>
                                    <span style={{ color: t.type === 'BUY' ? '#10b981' : '#ef4444' }}>{t.type}</span>
                                    <span>{t.symbol}</span>
                                    <span>${t.price}</span>
                                    <span style={{ color: t.pnl >= 0 ? '#10b981' : '#ef4444' }}>
                                        {t.pnl >= 0 ? '+' : ''}{t.pnl}%
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div style={{
            padding: '2px 0',
            fontSize: '0.85rem',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
            lineHeight: 1.6
        }}>
            {getPrefix()}
            <span style={{
                color: type === 'input' ? '#f9fafb' :
                    type === 'error' ? '#ef4444' :
                        type === 'success' ? '#10b981' :
                            type === 'thinking' ? '#a78bfa' :
                                type === 'plan' ? '#fbbf24' :
                                    '#9ca3af'
            }}>
                {content}
            </span>
        </div>
    );
};

// ==================== Command Palette ====================
const CommandPalette = ({ commands, filter, onSelect, selectedIndex }) => {
    const filteredCommands = commands.filter(c =>
        c.cmd.toLowerCase().includes(filter.toLowerCase()) ||
        c.desc.toLowerCase().includes(filter.toLowerCase())
    );

    const categories = [...new Set(filteredCommands.map(c => c.category))];

    if (filteredCommands.length === 0) return null;

    return (
        <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            right: 0,
            background: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '8px',
            marginBottom: '8px',
            maxHeight: '300px',
            overflow: 'auto',
            boxShadow: '0 -4px 20px rgba(0,0,0,0.5)'
        }}>
            {categories.map(cat => (
                <div key={cat}>
                    <div style={{
                        padding: '8px 12px',
                        fontSize: '0.7rem',
                        color: '#8b949e',
                        background: '#0d1117',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        position: 'sticky',
                        top: 0
                    }}>
                        {cat}
                    </div>
                    {filteredCommands.filter(c => c.category === cat).map((cmd, idx) => {
                        const globalIdx = filteredCommands.indexOf(cmd);
                        return (
                            <div
                                key={cmd.cmd}
                                onClick={() => onSelect(cmd)}
                                style={{
                                    padding: '10px 12px',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    background: globalIdx === selectedIndex ? '#21262d' : 'transparent',
                                    borderLeft: globalIdx === selectedIndex ? '2px solid #22d3ee' : '2px solid transparent'
                                }}
                            >
                                <div>
                                    <span style={{ color: '#22d3ee', fontFamily: 'monospace' }}>{cmd.cmd}</span>
                                    {cmd.args && (
                                        <span style={{ color: '#6b7280', marginLeft: '8px', fontSize: '0.8rem' }}>
                                            {cmd.args}
                                        </span>
                                    )}
                                    <div style={{ color: '#8b949e', fontSize: '0.75rem', marginTop: '2px' }}>
                                        {cmd.desc}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
};

// ==================== Help Output ====================
const HelpOutput = () => {
    const categories = [...new Set(COMMANDS.map(c => c.category))];

    return (
        <div style={{
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '6px',
            margin: '8px 0',
            padding: '16px',
            fontSize: '0.8rem',
            fontFamily: 'monospace'
        }}>
            <div style={{ color: '#f59e0b', marginBottom: '12px', fontSize: '0.9rem' }}>
                Available Commands
            </div>
            {categories.map(cat => (
                <div key={cat} style={{ marginBottom: '16px' }}>
                    <div style={{ color: '#8b949e', marginBottom: '8px', textTransform: 'uppercase', fontSize: '0.7rem' }}>
                        {cat}
                    </div>
                    {COMMANDS.filter(c => c.category === cat).map(cmd => (
                        <div key={cmd.cmd} style={{
                            display: 'flex',
                            gap: '16px',
                            padding: '4px 0'
                        }}>
                            <span style={{ color: '#22d3ee', minWidth: '140px' }}>
                                {cmd.cmd} {cmd.args && <span style={{ color: '#6b7280' }}>{cmd.args}</span>}
                            </span>
                            <span style={{ color: '#9ca3af' }}>{cmd.desc}</span>
                        </div>
                    ))}
                </div>
            ))}
            <div style={{ color: '#6b7280', marginTop: '12px', fontSize: '0.75rem' }}>
                Shortcuts: Ctrl+K (commands) • Ctrl+L (clear) • ↑↓ (history) • Tab (autocomplete)
            </div>
        </div>
    );
};

// ==================== Status Output ====================
const StatusOutput = ({ session, mode, model, algoReady }) => (
    <div style={{
        background: '#0d1117',
        border: '1px solid #30363d',
        borderRadius: '6px',
        margin: '8px 0',
        padding: '16px',
        fontSize: '0.8rem',
        fontFamily: 'monospace'
    }}>
        <div style={{ color: '#f59e0b', marginBottom: '12px' }}>Session Status</div>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px' }}>
            <span style={{ color: '#8b949e' }}>Session:</span>
            <span style={{ color: session ? '#10b981' : '#ef4444' }}>
                {session ? `Active (${session.slice(0, 8)}...)` : 'Not started'}
            </span>
            <span style={{ color: '#8b949e' }}>Mode:</span>
            <span style={{ color: '#22d3ee' }}>{mode}</span>
            <span style={{ color: '#8b949e' }}>Model:</span>
            <span style={{ color: '#c9d1d9' }}>{model || 'Not selected'}</span>
            <span style={{ color: '#8b949e' }}>Algorithm:</span>
            <span style={{ color: algoReady ? '#10b981' : '#6b7280' }}>
                {algoReady ? 'Ready for deployment' : 'Not created'}
            </span>
        </div>
    </div>
);

// ==================== Main Component ====================
const SandboxResearchPage = () => {
    const navigate = useNavigate();

    // State
    const [models, setModels] = useState({});
    const [selectedModel, setSelectedModel] = useState('');
    const [sessionId, setSessionId] = useState(null);
    const [mode, setMode] = useState('build'); // build, plan
    const [lines, setLines] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [showPalette, setShowPalette] = useState(false);
    const [paletteFilter, setPaletteFilter] = useState('');
    const [paletteIndex, setPaletteIndex] = useState(0);
    const [commandHistory, setCommandHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [finalCode, setFinalCode] = useState(null);
    const [planData, setPlanData] = useState(null);
    const [researchData, setResearchData] = useState(null);  // Stores findings after /approve

    // Refs
    const terminalRef = useRef(null);
    const inputRef = useRef(null);

    // Load models
    useEffect(() => {
        api.get('/available_models')
            .then(res => {
                if (res.data && Object.keys(res.data).length > 0) {
                    setModels(res.data);
                    const first = Object.values(res.data).flat()[0];
                    if (first) setSelectedModel(first);
                }
            })
            .catch(console.error);
    }, []);

    // Auto-scroll terminal
    useEffect(() => {
        if (terminalRef.current) {
            terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
        }
    }, [lines]);

    // Focus input on click (but not on interactive elements)
    useEffect(() => {
        const handleClick = (e) => {
            // Don't steal focus from interactive elements
            const tag = e.target.tagName.toLowerCase();
            const isInteractive = ['select', 'option', 'button', 'a', 'input'].includes(tag) ||
                e.target.closest('select') ||
                e.target.closest('button') ||
                e.target.closest('a');
            if (!isInteractive) {
                inputRef.current?.focus();
            }
        };
        document.addEventListener('click', handleClick);
        return () => document.removeEventListener('click', handleClick);
    }, []);


    // Add line to terminal
    const addLine = useCallback((type, content) => {
        setLines(prev => [...prev, { type, content, timestamp: Date.now() }]);
    }, []);

    // Socket.IO Listeners
    useEffect(() => {
        const handleLog = (data) => {
            if (data.session_id && sessionId && data.session_id !== sessionId) return;
            addLine(data.type || 'info', data.message);
        };

        socket.on('sandbox_log', handleLog);

        return () => {
            socket.off('sandbox_log', handleLog);
        };
    }, [sessionId, addLine]);


    // Create session
    const createSession = async () => {
        if (!selectedModel || sessionId) return sessionId;

        try {
            const res = await api.post('/sandbox/create', { model: selectedModel });
            if (res.data.session_id) {
                setSessionId(res.data.session_id);
                return res.data.session_id;
            }
        } catch (err) {
            addLine('error', `Failed to create session: ${err.message}`);
        }
        return null;
    };

    // Process command
    const processCommand = async (input) => {
        const trimmed = input.trim();
        if (!trimmed) return;

        // Add to history
        setCommandHistory(prev => [...prev.filter(h => h !== trimmed), trimmed]);
        setHistoryIndex(-1);

        // Show input
        addLine('input', trimmed);

        // Parse command
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);

        // Handle commands
        switch (cmd) {
            case '/help':
                setLines(prev => [...prev, { type: 'help', content: null }]);
                return;

            case '/clear':
                setLines([]);
                addLine('system', 'Terminal cleared');
                return;

            case '/status':
                setLines(prev => [...prev, {
                    type: 'status',
                    content: { session: sessionId, mode, model: selectedModel, algoReady: !!finalCode }
                }]);
                return;

            case '/exit':
                if (sessionId) {
                    try { await api.post('/sandbox/close', { session_id: sessionId }); } catch { }
                }
                navigate('/dashboard');
                return;

            case '/plan':
                setMode('plan');
                // If there's a request after /plan, process it immediately
                if (args.length > 0) {
                    const request = args.join(' ');
                    addLine('plan', `📋 Plan Mode: ${request}`);
                    await sendPlanRequest(request);
                } else {
                    addLine('plan', '📋 Entering Plan Mode');
                    addLine('info', 'Usage: /plan <your request>');
                    addLine('info', 'Example: /plan Find correlation between NVDA and PLTR');
                }
                return;

            case '/approve':
                if (!planData) {
                    addLine('error', 'No plan to approve. Create a plan first with /plan <request>');
                    return;
                }
                addLine('success', '✓ Plan approved! Running research...');
                await runResearch(planData.originalRequest, planData.plan);
                return;

            case '/build':
                if (!researchData) {
                    // If no research data but we have a plan, suggest /approve first
                    if (planData) {
                        addLine('error', 'Research not completed. Run /approve first to execute your plan.');
                    } else {
                        addLine('error', 'No research data available. Start with /plan <request>, then /approve, then /build');
                    }
                    return;
                }
                addLine('success', '🔨 Building algorithm from research findings...');
                await buildAlgorithm(researchData);
                return;

            case '/deploy':
                if (!finalCode) {
                    addLine('error', 'No algorithm to deploy. Build one first!');
                    return;
                }
                await handleDeploy();
                return;

            case '/code':
                if (!finalCode) {
                    addLine('error', 'No algorithm code available');
                    return;
                }
                setLines(prev => [...prev, {
                    type: 'code',
                    content: { code: finalCode, lines: finalCode.split('\n').length }
                }]);
                return;

            case '/model':
                if (args.length === 0) {
                    addLine('info', `Current model: ${selectedModel}`);
                    addLine('info', 'Available models:');
                    Object.entries(models).forEach(([provider, list]) => {
                        list.forEach(m => addLine('info', `  ${m}`));
                    });
                } else {
                    const newModel = args.join(' ');
                    const allModels = Object.values(models).flat();
                    const found = allModels.find(m => m.toLowerCase().includes(newModel.toLowerCase()));
                    if (found) {
                        setSelectedModel(found);
                        setSessionId(null); // Reset session for new model
                        addLine('success', `Model changed to: ${found}`);
                    } else {
                        addLine('error', `Model not found: ${newModel}`);
                    }
                }
                return;

            case '/backtest':
                await handleBacktest(args);
                return;

            case '/analyze':
            case '/insider':
            case '/institutional':
            case '/financials':
            case '/news':
            case '/sentiment':
            case '/research':
            case '/compare':
                // These are data commands - send to AI
                await sendMessage(trimmed, false);
                return;

            default:
                // Not a command, send as message
                if (trimmed.startsWith('/')) {
                    addLine('error', `Unknown command: ${cmd}. Type /help for available commands.`);
                } else {
                    await sendMessage(trimmed, false);
                }
        }
    };

    // Send message to AI
    const sendMessage = async (message, skipPlan = false) => {
        setIsProcessing(true);

        try {
            // Ensure session exists
            let sid = sessionId;
            if (!sid) {
                sid = await createSession();
                if (!sid) {
                    setIsProcessing(false);
                    return;
                }
            }

            // In plan mode, modify the request
            const actualMessage = (mode === 'plan' && !skipPlan)
                ? `[PLAN MODE] Create a detailed research and implementation plan for: ${message}. Do NOT execute any code yet. Provide: 1) Research questions, 2) Data sources needed, 3) Step-by-step strategy outline, 4) Potential risks/considerations.`
                : message;

            addLine('thinking', 'Processing...');

            const res = await api.post('/sandbox/message', {
                session_id: sid,
                message: actualMessage
            });

            // Remove thinking line
            setLines(prev => prev.filter(l => l.type !== 'thinking' || l.content !== 'Processing...'));

            if (res.data.error) {
                addLine('error', res.data.error);
            } else {
                // Show API calls
                if (res.data.api_calls?.length > 0) {
                    res.data.api_calls.forEach(call => {
                        addLine('info', call);
                    });
                }

                // Show code blocks
                if (res.data.code_blocks?.length > 0) {
                    res.data.code_blocks.forEach(block => {
                        setLines(prev => [...prev, {
                            type: 'code',
                            content: {
                                code: block.code,
                                lines: block.code.split('\n').length,
                                output: block.result,
                                error: block.error
                            }
                        }]);
                    });
                }

                // Show response
                if (res.data.response) {
                    if (mode === 'plan' && !skipPlan) {
                        setLines(prev => [...prev, { type: 'plan-box', content: res.data.response }]);
                        setPlanData({ originalRequest: message, plan: res.data.response });
                        addLine('info', 'Type /approve to start building, or continue refining the plan');
                    } else {
                        addLine('success', res.data.response);
                    }
                }

                // Check for final code
                if (res.data.is_final && res.data.final_code) {
                    setFinalCode(res.data.final_code);
                    addLine('success', 'Algorithm ready! Use /deploy to add to arena or /code to view');
                }
            }
        } catch (err) {
            addLine('error', `Error: ${err.message}`);
        }

        setIsProcessing(false);
    };

    // STAGE 1: Send plan request - creates a plan only, no code execution
    const sendPlanRequest = async (request) => {
        setIsProcessing(true);

        try {
            let sid = sessionId;
            if (!sid) {
                sid = await createSession();
                if (!sid) {
                    setIsProcessing(false);
                    return;
                }
            }

            const planPrompt = `[PLAN MODE - NO CODE EXECUTION]
Create a detailed research and implementation plan for: "${request}"

Do NOT execute any code yet. Only provide:

1. **Research Questions** - What do we need to find out?
2. **Data Sources Needed** - Which API endpoints will we use?
3. **Step-by-Step Strategy Outline** - How will we analyze this?
4. **Potential Risks/Considerations** - What could go wrong?
5. **Expected Findings** - What patterns might we discover?

Format the plan clearly with headers. After I approve, I will run /approve to execute the research.`;

            addLine('thinking', 'Creating research plan...');

            const res = await api.post('/sandbox/message', {
                session_id: sid,
                message: planPrompt
            });

            setLines(prev => prev.filter(l => !(l.type === 'thinking' && l.content === 'Creating research plan...')));

            if (res.data.error) {
                addLine('error', res.data.error);
            } else {
                // Show API calls that will be used
                if (res.data.api_calls?.length > 0) {
                    res.data.api_calls.forEach(call => {
                        addLine('info', `→ ${call}`);
                    });
                }

                // Show the plan
                if (res.data.response) {
                    setLines(prev => [...prev, { type: 'plan-box', content: res.data.response }]);
                    setPlanData({ originalRequest: request, plan: res.data.response });
                    addLine('info', '→ Type /approve to execute this research plan');
                }
            }
        } catch (err) {
            addLine('error', `Error: ${err.message}`);
        }

        setIsProcessing(false);
    };

    // STAGE 2: Run research - executes the plan and shows findings
    const runResearch = async (originalRequest, plan) => {
        setIsProcessing(true);

        try {
            let sid = sessionId;
            if (!sid) {
                sid = await createSession();
                if (!sid) {
                    setIsProcessing(false);
                    return;
                }
            }

            const researchPrompt = `[RESEARCH MODE - EXECUTE AND ANALYZE]

API SETUP (MUST USE):
\`\`\`python
import os
API_KEY = os.environ.get('FINANCIAL_DATASETS_API_KEY')
headers = {"X-API-KEY": API_KEY}
BASE_URL = "https://api.financialdatasets.ai"
# Use: requests.get(f"{BASE_URL}/prices", params={...}, headers=headers)
\`\`\`

CORRECT ENDPOINTS:
- /prices?ticker=NVDA&interval=daily&start_date=2024-01-01&end_date=2025-01-01
- /news?ticker=NVDA&limit=20  
- DO NOT use /historical-prices!

Plan:
${plan.substring(0, 1200)}

EXECUTE: Fetch data, compute patterns, show findings with numbers.
DO NOT build algorithm yet.`;

            addLine('thinking', 'Executing research...');

            const res = await api.post('/sandbox/message', {
                session_id: sid,
                message: researchPrompt
            });

            setLines(prev => prev.filter(l => !(l.type === 'thinking' && l.content === 'Executing research...')));

            if (res.data.error) {
                addLine('error', res.data.error);
            } else {
                // Show API calls
                if (res.data.api_calls?.length > 0) {
                    res.data.api_calls.forEach(call => {
                        addLine('info', `→ ${call}`);
                    });
                }

                // Show code blocks that were executed
                if (res.data.code_blocks?.length > 0) {
                    res.data.code_blocks.forEach(block => {
                        setLines(prev => [...prev, {
                            type: 'code',
                            content: {
                                code: block.code,
                                lines: block.code.split('\n').length,
                                output: block.result,
                                error: block.error
                            }
                        }]);
                    });
                }

                // Show research findings
                if (res.data.response) {
                    setLines(prev => [...prev, { type: 'research-findings', content: res.data.response }]);
                    // Save research data for build phase
                    setResearchData({
                        originalRequest,
                        plan,
                        findings: res.data.response,
                        codeBlocks: res.data.code_blocks || []
                    });
                    addLine('success', '✓ Research complete! Type /build to create your trading algorithm');
                }
            }
        } catch (err) {
            addLine('error', `Error: ${err.message}`);
        }

        setIsProcessing(false);
    };

    // STAGE 3: Build algorithm - creates the trading strategy based on findings
    const buildAlgorithm = async (research) => {
        setIsProcessing(true);
        setMode('build');

        try {
            let sid = sessionId;
            if (!sid) {
                sid = await createSession();
                if (!sid) {
                    setIsProcessing(false);
                    return;
                }
            }

            // Truncate findings to avoid token limit (keep first 1000 chars)
            const truncatedFindings = research.findings.length > 1000
                ? research.findings.substring(0, 1000) + '...'
                : research.findings;

            const buildPrompt = `[BUILD TRADING ALGORITHM - FINAL OUTPUT]

Research findings for: ${research.originalRequest}
${truncatedFindings}

CRITICAL RULES:
1. Output ONLY the execute_strategy function - no imports, no data fetching
2. DO NOT include requests, pandas, or API calls - data is in market_data
3. portfolio is {symbol: quantity} NOT tuple! Use: portfolio.get('BTC', 0)

EXACT FORMAT:
\`\`\`python
def execute_strategy(market_data, tick, cash_balance, portfolio, market_state=None, agent_state=None):
    btc = market_data.get('BTC', {})
    price = btc.get('price', 0) or 0
    qty = portfolio.get('BTC', 0)  # NOT portfolio.get('BTC', (0,0))[0]!
    
    if price > 0 and cash_balance > 100:
        return ("BUY", "BTC", 0.01)
    return ("HOLD", None, 0)
\`\`\`

Generate now. NO API CALLS.`;

            addLine('thinking', 'Building algorithm...');

            const res = await api.post('/sandbox/message', {
                session_id: sid,
                message: buildPrompt
            });

            setLines(prev => prev.filter(l => !(l.type === 'thinking' && l.content === 'Building algorithm...')));

            if (res.data.error) {
                addLine('error', res.data.error);
            } else {
                // Show code blocks
                if (res.data.code_blocks?.length > 0) {
                    res.data.code_blocks.forEach(block => {
                        setLines(prev => [...prev, {
                            type: 'code',
                            content: {
                                code: block.code,
                                lines: block.code.split('\n').length,
                                output: block.result,
                                error: block.error
                            }
                        }]);
                    });
                }

                // Show response
                if (res.data.response) {
                    addLine('success', res.data.response);
                }

                // Check for final code
                if (res.data.is_final && res.data.final_code) {
                    setFinalCode(res.data.final_code);
                    addLine('success', '🎉 Algorithm ready! Use /deploy to add to arena or /code to view');
                } else {
                    // If no final code detected, ask the AI to confirm
                    addLine('info', 'If the algorithm looks good, use /deploy to save and deploy it');
                }
            }
        } catch (err) {
            addLine('error', `Error: ${err.message}`);
        }

        setIsProcessing(false);
    };

    // Handle backtest
    const handleBacktest = async (args) => {
        if (!finalCode) {
            addLine('error', 'No algorithm to backtest. Build one first!');
            return;
        }

        // Parse args
        let period = '3m';
        let initial = 10000;

        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--period' && args[i + 1]) {
                period = args[i + 1];
            }
            if (args[i] === '--initial' && args[i + 1]) {
                initial = parseInt(args[i + 1]) || 10000;
            }
        }

        addLine('info', `Running backtest: period=${period}, initial=$${initial}`);
        addLine('thinking', 'Backtesting...');

        // Simulate backtest results (in real implementation, call backend)
        await new Promise(r => setTimeout(r, 2000));

        setLines(prev => prev.filter(l => !(l.type === 'thinking' && l.content === 'Backtesting...')));

        // Mock backtest results
        const results = {
            metrics: [
                { label: 'Total Return', value: '+12.4%', color: '#10b981' },
                { label: 'Sharpe Ratio', value: '1.82', color: '#22d3ee' },
                { label: 'Max Drawdown', value: '-4.2%', color: '#ef4444' },
                { label: 'Win Rate', value: '58%', color: '#f59e0b' },
            ],
            trades: [
                { type: 'BUY', symbol: 'BTC', price: '94,230', pnl: 2.1 },
                { type: 'SELL', symbol: 'BTC', price: '96,210', pnl: 1.8 },
                { type: 'BUY', symbol: 'ETH', price: '3,420', pnl: -0.5 },
                { type: 'SELL', symbol: 'SOL', price: '187', pnl: 3.2 },
                { type: 'BUY', symbol: 'BTC', price: '95,100', pnl: 0.9 },
            ]
        };

        setLines(prev => [...prev, { type: 'backtest-results', content: results }]);
        addLine('success', `Backtest complete: ${period} period, $${initial} initial capital`);
    };

    // Handle deploy
    const handleDeploy = async () => {
        if (!finalCode) {
            addLine('error', 'No algorithm code to deploy. Build one first!');
            return;
        }

        const agentName = `Agent_sandbox_${Date.now().toString(36)}`;
        addLine('info', `Deploying as ${agentName}...`);

        try {
            const res = await api.post('/sandbox/finalize', {
                session_id: sessionId || 'no-session',
                agent_name: agentName,
                code: finalCode  // Send code as fallback
            });

            if (res.data.error) {
                addLine('error', `Deploy failed: ${res.data.error}`);
                return;
            }

            await api.post('/deploy_agent', { name: res.data.agent_name });
            addLine('success', `Agent "${res.data.agent_name}" deployed to arena!`);
            addLine('info', 'Redirecting to dashboard...');

            setTimeout(() => navigate('/dashboard'), 1500);
        } catch (err) {
            addLine('error', `Deploy failed: ${err.message}`);
        }
    };

    // Handle input
    const handleKeyDown = (e) => {
        // Ctrl+K - Open command palette
        if (e.ctrlKey && e.key === 'k') {
            e.preventDefault();
            setShowPalette(true);
            setInputValue('/');
            setPaletteFilter('');
            return;
        }

        // Ctrl+L - Clear
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            setLines([]);
            addLine('system', 'Terminal cleared');
            return;
        }

        // Show palette when typing /
        if (e.key === '/' && inputValue === '') {
            setShowPalette(true);
            setPaletteFilter('');
            setPaletteIndex(0);
        }

        // Navigate palette
        if (showPalette) {
            const filtered = COMMANDS.filter(c =>
                c.cmd.toLowerCase().includes(paletteFilter.toLowerCase()) ||
                c.desc.toLowerCase().includes(paletteFilter.toLowerCase())
            );

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setPaletteIndex(prev => Math.min(prev + 1, filtered.length - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setPaletteIndex(prev => Math.max(prev - 1, 0));
                return;
            }
            // Tab always autocompletes
            if (e.key === 'Tab') {
                e.preventDefault();
                const selected = filtered[paletteIndex];
                if (selected) {
                    setInputValue(selected.cmd + (selected.args ? ' ' : ''));
                    setShowPalette(false);
                }
                return;
            }
            // Enter: if exact match to a no-args command, submit it; otherwise autocomplete
            if (e.key === 'Enter' && filtered.length > 0) {
                const exactMatch = COMMANDS.find(c => c.cmd === inputValue);
                if (exactMatch && !exactMatch.args) {
                    // Exact match to command without args - submit it
                    e.preventDefault();
                    setShowPalette(false);
                    processCommand(inputValue);
                    setInputValue('');
                    return;
                }
                // Otherwise autocomplete
                e.preventDefault();
                const selected = filtered[paletteIndex];
                if (selected) {
                    setInputValue(selected.cmd + (selected.args ? ' ' : ''));
                    setShowPalette(false);
                }
                return;
            }
            if (e.key === 'Escape') {
                setShowPalette(false);
                return;
            }
        }

        // Command history
        if (e.key === 'ArrowUp' && !showPalette) {
            e.preventDefault();
            if (commandHistory.length > 0) {
                const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
                setHistoryIndex(newIndex);
                setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '');
            }
            return;
        }
        if (e.key === 'ArrowDown' && !showPalette) {
            e.preventDefault();
            if (historyIndex > 0) {
                const newIndex = historyIndex - 1;
                setHistoryIndex(newIndex);
                setInputValue(commandHistory[commandHistory.length - 1 - newIndex] || '');
            } else {
                setHistoryIndex(-1);
                setInputValue('');
            }
            return;
        }

        // Submit
        if (e.key === 'Enter' && !e.shiftKey && !showPalette) {
            e.preventDefault();
            if (inputValue.trim() && !isProcessing) {
                processCommand(inputValue);
                setInputValue('');
            }
        }
    };

    // Update palette filter
    useEffect(() => {
        if (inputValue.startsWith('/')) {
            const hasSpace = inputValue.includes(' ');
            // Only show palette when typing command (before space)
            // Once user adds a space (typing arguments), close palette
            if (hasSpace) {
                setShowPalette(false);
            } else {
                setPaletteFilter(inputValue.slice(1));
                setShowPalette(true);
                setPaletteIndex(0);
            }
        } else {
            setShowPalette(false);
        }
    }, [inputValue]);

    // Render line
    const renderLine = (line, idx) => {
        if (line.type === 'help') {
            return <HelpOutput key={idx} />;
        }
        if (line.type === 'status') {
            return <StatusOutput key={idx} {...line.content} />;
        }
        return <TerminalLine key={idx} {...line} />;
    };

    return (
        <div style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            background: '#0a0e17',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
        }}>
            {/* Header */}
            <header style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 16px',
                background: '#161b22',
                borderBottom: '1px solid #30363d'
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <Link to="/dashboard" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '1.1rem', fontWeight: '700', color: '#f9fafb' }}>
                            algoclash
                        </span>
                        <span style={{ color: '#22d3ee' }}>sandbox</span>
                    </Link>
                    <span style={{
                        fontSize: '0.6rem',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        background: '#22d3ee',
                        color: '#0a0e17',
                        fontWeight: '700'
                    }}>BETA</span>
                    <span style={{
                        fontSize: '0.7rem',
                        padding: '2px 8px',
                        borderRadius: '3px',
                        background: mode === 'plan' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                        color: mode === 'plan' ? '#f59e0b' : '#10b981',
                        border: `1px solid ${mode === 'plan' ? '#f59e0b' : '#10b981'}40`
                    }}>
                        {mode.toUpperCase()} MODE
                    </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {/* Model selector */}
                    <select
                        value={selectedModel}
                        onChange={(e) => {
                            setSelectedModel(e.target.value);
                            setSessionId(null);
                        }}
                        style={{
                            padding: '6px 12px',
                            background: '#21262d',
                            border: '1px solid #30363d',
                            color: '#c9d1d9',
                            borderRadius: '4px',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            minWidth: '200px',
                            maxWidth: '280px',
                            appearance: 'none',
                            WebkitAppearance: 'none',
                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238b949e' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`,
                            backgroundRepeat: 'no-repeat',
                            backgroundPosition: 'right 8px center',
                            paddingRight: '28px'
                        }}
                    >
                        {Object.entries(models).map(([provider, list]) => (
                            <optgroup key={provider} label={provider} style={{ background: '#161b22', color: '#8b949e' }}>
                                {list.map(m => (
                                    <option key={m} value={m} style={{ background: '#21262d', color: '#c9d1d9', padding: '4px' }}>
                                        {m.includes(':') ? m.split(':').pop() : m.split('/').pop()}
                                    </option>
                                ))}
                            </optgroup>
                        ))}
                    </select>

                    <Link
                        to="/dashboard"
                        style={{
                            padding: '4px 10px',
                            background: '#21262d',
                            border: '1px solid #30363d',
                            color: '#8b949e',
                            borderRadius: '4px',
                            textDecoration: 'none',
                            fontSize: '0.75rem'
                        }}
                    >
                        Dashboard
                    </Link>
                </div>
            </header>

            {/* Terminal */}
            <div
                ref={terminalRef}
                style={{
                    flex: 1,
                    overflow: 'auto',
                    padding: '16px',
                    background: '#0a0e17'
                }}
            >
                {lines.length === 0 ? (
                    <div style={{ color: '#6b7280', padding: '20px 0' }}>
                        <div style={{ color: '#22d3ee', marginBottom: '16px' }}>
                            Welcome to AlgoClash Sandbox
                        </div>
                        <div style={{ marginBottom: '8px' }}>
                            <span style={{ color: '#8b949e' }}>Type </span>
                            <span style={{ color: '#22d3ee' }}>/help</span>
                            <span style={{ color: '#8b949e' }}> to see available commands</span>
                        </div>
                        <div style={{ marginBottom: '8px' }}>
                            <span style={{ color: '#8b949e' }}>Press </span>
                            <span style={{ color: '#f59e0b' }}>Ctrl+K</span>
                            <span style={{ color: '#8b949e' }}> to open command palette</span>
                        </div>
                        <div style={{ marginBottom: '16px' }}>
                            <span style={{ color: '#8b949e' }}>Or just start typing to build an algorithm</span>
                        </div>
                        <div style={{ color: '#4b5563', fontSize: '0.8rem' }}>
                            Examples:
                            <div style={{ marginTop: '8px', paddingLeft: '16px' }}>
                                <div>$ Build an arbitrage algo for Pepsi and Coke</div>
                                <div>$ /plan Find correlation between NVDA and defense stocks</div>
                                <div>$ /analyze TSLA</div>
                                <div>$ /insider AAPL</div>
                            </div>
                        </div>
                    </div>
                ) : (
                    lines.map((line, idx) => renderLine(line, idx))
                )}

                {isProcessing && (
                    <div style={{ color: '#a78bfa', padding: '8px 0' }}>
                        <span className="blink">▋</span> Processing...
                    </div>
                )}
            </div>

            {/* Input Area */}
            <div style={{
                borderTop: '1px solid #30363d',
                background: '#161b22',
                padding: '12px 16px'
            }}>
                {/* Tools */}
                <div style={{
                    display: 'flex',
                    gap: '8px',
                    marginBottom: '10px',
                    flexWrap: 'wrap'
                }}>
                    {TOOLS.map((tool, idx) => (
                        <span
                            key={idx}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                padding: '2px 8px',
                                background: `${tool.color}15`,
                                border: `1px solid ${tool.color}30`,
                                borderRadius: '3px',
                                fontSize: '0.65rem',
                                color: tool.color
                            }}
                        >
                            {tool.icon} {tool.name}
                        </span>
                    ))}
                </div>

                {/* Input */}
                <div style={{ position: 'relative' }}>
                    {showPalette && (
                        <CommandPalette
                            commands={COMMANDS}
                            filter={paletteFilter}
                            onSelect={(cmd) => {
                                setInputValue(cmd.cmd + (cmd.args ? ' ' : ''));
                                setShowPalette(false);
                                inputRef.current?.focus();
                            }}
                            selectedIndex={paletteIndex}
                        />
                    )}

                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        background: '#0d1117',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '8px 12px'
                    }}>
                        <span style={{ color: '#22d3ee', fontWeight: '600' }}>$</span>
                        <input
                            ref={inputRef}
                            type="text"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={mode === 'plan' ? 'Describe what you want to plan...' : 'Type a command or message...'}
                            disabled={isProcessing}
                            autoFocus
                            style={{
                                flex: 1,
                                background: 'transparent',
                                border: 'none',
                                outline: 'none',
                                color: '#f9fafb',
                                fontSize: '0.9rem',
                                fontFamily: 'inherit'
                            }}
                        />
                        <span style={{ color: '#4b5563', fontSize: '0.7rem' }}>
                            {sessionId ? '●' : '○'}
                        </span>
                    </div>
                </div>

                {/* Status bar */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: '8px',
                    fontSize: '0.65rem',
                    color: '#4b5563'
                }}>
                    <span>
                        {sessionId ? (
                            <span style={{ color: '#10b981' }}>● connected</span>
                        ) : (
                            <span>○ disconnected</span>
                        )}
                        <span style={{ marginLeft: '12px' }}>{selectedModel.split('/').pop()}</span>
                    </span>
                    <span>
                        Ctrl+K commands • Ctrl+L clear • ↑↓ history • Tab complete
                    </span>
                </div>
            </div>

            <style>{`
                .blink {
                    animation: blink 1s infinite;
                }
                @keyframes blink {
                    0%, 50% { opacity: 1; }
                    51%, 100% { opacity: 0; }
                }
                input::placeholder {
                    color: #4b5563;
                }
                select {
                    outline: none;
                }
                select:focus {
                    border-color: #22d3ee !important;
                    box-shadow: 0 0 0 2px rgba(34, 211, 238, 0.2);
                }
                select option {
                    padding: 8px 12px;
                }
                select optgroup {
                    font-weight: 600;
                    color: #8b949e;
                    background: #161b22;
                    padding: 4px 0;
                }
                ::-webkit-scrollbar {
                    width: 8px;
                }
                ::-webkit-scrollbar-track {
                    background: #0a0e17;
                }
                ::-webkit-scrollbar-thumb {
                    background: #30363d;
                    border-radius: 4px;
                }
                ::-webkit-scrollbar-thumb:hover {
                    background: #484f58;
                }
            `}</style>
        </div>
    );
};

export default SandboxResearchPage;
