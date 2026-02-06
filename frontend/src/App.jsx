import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import SelectionPage from './pages/SelectionPage';
import DashboardPage from './pages/DashboardPage';
import LeaderboardPage from './pages/LeaderboardPage';
import SandboxResearchPage from './pages/SandboxResearchPage';
import ContactPage from './pages/ContactPage';
import './index.css';

function App() {
    return (
        <Router>
            <div className="app-container">
                <Routes>
                    <Route path="/" element={<SelectionPage />} />
                    <Route path="/dashboard" element={<DashboardPage />} />
                    <Route path="/leaderboard" element={<LeaderboardPage />} />
                    <Route path="/sandbox" element={<SandboxResearchPage />} />
                    <Route path="/contact" element={<ContactPage />} />
                </Routes>
            </div>
        </Router>
    );
}

export default App;
