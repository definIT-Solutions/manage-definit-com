import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { PhoneCall, List, Search, Sun, Moon, X, PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { api } from './api/client';
import SharedIconRail from './components/shared/SharedIconRail';
import RecordingsView from './pages/RecordingsView';
import RecordingDetail from './pages/RecordingDetail';

interface User { id: string; email: string; displayName: string | null }
interface PhoneNumberEntry { phone_number: string; name: string | null; count: number }

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<User | null>(null);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumberEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light'
  );

  const refreshPhoneNumbers = () =>
    api.getPhoneNumbers().then(data => setPhoneNumbers(data.phone_numbers)).catch(() => {});

  useEffect(() => {
    api.getMe().then(data => setUser(data.user)).catch(() => {});
    refreshPhoneNumbers();
  }, []);

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('callscribe-theme', next);
    localStorage.setItem('theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  const getActiveView = () => {
    if (location.pathname.startsWith('/number/')) return 'number';
    if (location.pathname.startsWith('/recording/')) return 'detail';
    return 'all';
  };

  const activeNumber = location.pathname.startsWith('/number/')
    ? decodeURIComponent(location.pathname.split('/number/')[1]) : null;

  const handleRailNavigate = (path: string, external?: boolean) => {
    if (external) {
      window.location.href = path;
    } else {
      navigate(path);
    }
  };

  return (
    <div className="zendesk-layout">
      <SharedIconRail activeId="callscribe" onNavigate={handleRailNavigate} />

      <aside className="sidebar">
        <div className="sidebar-header">
          <PhoneCall size={22} />
          <h1 className="sidebar-title">CallScribe</h1>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${getActiveView() === 'all' ? 'active' : ''}`}
            onClick={() => navigate('/')}
          >
            <List size={18} /> <span>All Recordings</span>
          </button>
        </nav>

        {phoneNumbers.length > 0 && (
          <>
            <div className="sidebar-divider" />
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <span>By Number</span>
              </div>
              {phoneNumbers.map(pn => (
                <button
                  key={pn.phone_number}
                  className={`nav-item ${activeNumber === pn.phone_number ? 'active' : ''}`}
                  onClick={() => navigate(`/number/${encodeURIComponent(pn.phone_number)}`)}
                >
                  <PhoneIncoming size={18} />
                  <span>{pn.name || pn.phone_number}</span>
                  <span className="nav-count">{pn.count}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </aside>

      <div className="zendesk-main">
        <header className="top-bar">
          <div className="top-bar-left">
            <span className="top-bar-app-name">CallScribe</span>
          </div>
          <div className="search-box">
            <Search size={18} />
            <input
              type="text"
              placeholder="Search recordings..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="icon-btn" onClick={() => setSearchQuery('')}><X size={16} /></button>
            )}
          </div>
          <div className="top-bar-actions">
            <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            {user && (
              <div className="top-bar-avatar">
                {user.displayName?.charAt(0) || user.email?.charAt(0) || 'U'}
              </div>
            )}
          </div>
        </header>

        <main className="zendesk-content">
          <Routes>
            <Route path="/" element={<RecordingsView searchQuery={searchQuery} onContactSaved={refreshPhoneNumbers} />} />
            <Route path="/number/:phoneNumber" element={<RecordingsView searchQuery={searchQuery} onContactSaved={refreshPhoneNumbers} />} />
            <Route path="/recording/:id" element={<RecordingDetail />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
