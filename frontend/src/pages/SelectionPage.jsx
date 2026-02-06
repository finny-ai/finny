import { useEffect } from 'react';
import AgentSelection from '../components/AgentSelection';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

const SelectionPage = () => {
    const navigate = useNavigate();

    useEffect(() => {
        // Check if arena is already running
        api.get('/status')
            .then(res => {
                const data = res.data;
                if (data.arena_running && data.agent_count > 0) {
                    console.log("Arena running, redirecting to dashboard...");
                    navigate('/dashboard');
                }
            })
            .catch(err => console.error("Failed to check status:", err));
    }, [navigate]);

    const handleStart = () => {
        navigate('/dashboard');
    };

    return (
        <div className="selection-page" style={{ paddingTop: '50px' }}>
            <div className="logo" style={{ textAlign: 'center', fontSize: '3rem', marginBottom: '20px' }}>ALGO<span style={{ color: 'var(--accent-orange)' }}>CLASH</span> LIVE</div>

            {/* Sandbox Research Link */}
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <button
                    onClick={() => navigate('/sandbox')}
                    style={{
                        padding: '10px 20px',
                        background: 'rgba(41, 98, 255, 0.2)',
                        border: '1px solid var(--accent-blue)',
                        color: 'var(--accent-blue)',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontSize: '0.9rem'
                    }}
                >
                    Sandbox Research Agent - Create Custom Strategies
                </button>
            </div>

            <AgentSelection onStart={handleStart} />
        </div>
    );
};

export default SelectionPage;
