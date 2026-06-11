import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import DashboardsPage from './pages/DashboardsPage';
import DashboardPage from './pages/DashboardPage';
import CardsPage from './pages/CardsPage';
import CardStudio from './pages/CardStudio';

function NavItem({ to, label, icon }: { to: string; label: string; icon: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-xl px-3.5 py-2.5 font-display text-sm font-semibold transition ${
          isActive ? 'bg-white/10 text-white' : 'text-sky-200/70 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d={icon} />
      </svg>
      {label}
    </NavLink>
  );
}

export default function App() {
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-56 flex-col bg-accent-deep px-4 py-6">
        <div className="mb-8 flex items-center gap-2.5 px-2">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent font-display text-lg font-extrabold text-white">S</div>
          <div>
            <p className="font-display text-base font-extrabold leading-tight tracking-tight text-white">SpendBoard</p>
            <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-sky-300/60">Card Studio · POC</p>
          </div>
        </div>
        <nav className="space-y-1">
          <NavItem to="/dashboards" label="Dashboards" icon="M2 2h5v7H2zM9 2h5v4H9zM9 8h5v6H9zM2 11h5v3H2z" />
          <NavItem to="/cards" label="Card Library" icon="M2 4a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2zM2 6.5h12" />
        </nav>
        <div className="mt-auto rounded-xl bg-white/5 p-3.5">
          <p className="text-[11px] leading-relaxed text-sky-200/70">
            Cards are stored once and reused across dashboards — data flows from SQLite through the SQL on each card.
          </p>
        </div>
      </aside>
      <main className="ml-56 flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboards" replace />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/dashboards/:id" element={<DashboardPage />} />
          <Route path="/cards" element={<CardsPage />} />
          <Route path="/cards/new" element={<CardStudio />} />
          <Route path="/cards/:id/edit" element={<CardStudio />} />
        </Routes>
      </main>
    </div>
  );
}
