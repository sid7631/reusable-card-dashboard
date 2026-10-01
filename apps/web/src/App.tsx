import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import DashboardsPage from './pages/DashboardsPage';
import DashboardPage from './pages/DashboardPage';
import CardsPage from './pages/CardsPage';
import CardStudio from './pages/CardStudio';
import LoginPage from './pages/LoginPage';
import { AuthContext, currentUser, signOut, type SessionUser } from './lib/auth';
import { APP_THEMES, AppThemeContext, applyAppTheme, loadAppTheme } from './lib/theme';

function NavItem({ to, label, icon, collapsed }: { to: string; label: string; icon: string; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl py-2.5 font-display text-sm font-semibold transition ${
          collapsed ? 'justify-center px-0' : 'px-3.5'
        } ${isActive ? 'bg-white/10 text-white' : 'text-sky-200/70 hover:bg-white/5 hover:text-white'}`
      }
    >
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
        <path d={icon} />
      </svg>
      {!collapsed && label}
    </NavLink>
  );
}

export default function App() {
  const [user, setUser] = useState<SessionUser | null>(currentUser);
  const navigate = useNavigate();

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage onSignedIn={(u) => { setUser(u); navigate('/dashboards', { replace: true }); }} />} />
      </Routes>
    );
  }

  const logout = () => { signOut(); setUser(null); navigate('/login', { replace: true }); };
  return (
    <AuthContext.Provider value={{ user, signOut: logout }}>
      <Shell user={user} onSignOut={logout} />
    </AuthContext.Provider>
  );
}

function Shell({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sb-sidebar-collapsed') === '1');
  const [theme, setTheme] = useState(loadAppTheme);

  useEffect(() => { applyAppTheme(theme); }, [theme]);

  useEffect(() => {
    localStorage.setItem('sb-sidebar-collapsed', collapsed ? '1' : '0');
    // react-grid-layout only remeasures on window resize — nudge it after the width transition
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
    return () => clearTimeout(t);
  }, [collapsed]);

  return (
    <AppThemeContext.Provider value={theme}>
    <div className="flex min-h-screen">
      <aside className={`fixed inset-y-0 left-0 z-40 flex flex-col bg-accent-deep py-6 transition-all duration-300 ${collapsed ? 'w-16 px-2.5' : 'w-56 px-4'}`}>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute -right-3 top-9 z-50 flex size-6 items-center justify-center rounded-full border border-line bg-white text-ink-soft shadow-md transition hover:text-accent"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}>
            <path d="M6.5 1.5L3 5l3.5 3.5" />
          </svg>
        </button>

        <div className={`mb-8 flex items-center gap-2.5 ${collapsed ? 'justify-center' : 'px-2'}`}>
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent font-display text-lg font-extrabold text-white">S</div>
          {!collapsed && (
            <div className="overflow-hidden whitespace-nowrap">
              <p className="font-display text-base font-extrabold leading-tight tracking-tight text-white">SpendBoard</p>
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-sky-300/60">Governed analytics</p>
            </div>
          )}
        </div>
        <nav className="space-y-1">
          <NavItem to="/dashboards" label="Dashboards" icon="M2 2h5v7H2zM9 2h5v4H9zM9 8h5v6H9zM2 11h5v3H2z" collapsed={collapsed} />
          <NavItem to="/cards" label="Card Library" icon="M2 4a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2zM2 6.5h12" collapsed={collapsed} />
        </nav>
        <div className="mt-auto space-y-3">
          <div className={collapsed ? '' : 'rounded-xl bg-white/5 p-3.5'}>
            {!collapsed && (
              <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-300/60">App theme</p>
            )}
            <div className={`flex gap-1.5 ${collapsed ? 'flex-col items-center' : 'flex-wrap'}`}>
              {APP_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTheme(t.id)}
                  title={t.label}
                  aria-label={`Theme: ${t.label}`}
                  className={`size-5 rounded-full transition hover:scale-110 ${
                    theme === t.id ? 'ring-2 ring-white ring-offset-2 ring-offset-accent-deep' : 'opacity-70 hover:opacity-100'
                  }`}
                  style={{ background: `linear-gradient(135deg, ${t.accent} 55%, ${t.deep} 55%)` }}
                />
              ))}
            </div>
          </div>
          <div className={`flex items-center gap-2.5 rounded-xl bg-white/5 ${collapsed ? 'flex-col p-1.5' : 'p-2.5'}`}>
            <span title={`${user.name} (${user.role})`}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent font-display text-xs font-bold text-white">
              {user.name.split(' ').map((p) => p[0]).join('')}
            </span>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-xs font-bold text-white">{user.name}</p>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-300/70">{user.role}</p>
              </div>
            )}
            <button onClick={onSignOut} title="Sign out" aria-label="Sign out"
              className="rounded-lg p-1.5 text-sky-200/70 transition hover:bg-white/10 hover:text-white">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6" />
              </svg>
            </button>
          </div>
        </div>
      </aside>
      <main className={`flex-1 transition-all duration-300 ${collapsed ? 'ml-16' : 'ml-56'}`}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboards" replace />} />
          <Route path="/login" element={<Navigate to="/dashboards" replace />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/dashboards/:id" element={<DashboardPage />} />
          <Route path="/cards" element={<CardsPage />} />
          <Route path="/cards/new" element={<CardStudio />} />
          <Route path="/cards/:id/edit" element={<CardStudio />} />
        </Routes>
      </main>
    </div>
    </AppThemeContext.Provider>
  );
}
