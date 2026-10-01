import { useEffect, useState } from 'react';
import { directory, signIn, type DirectoryUser, type SessionUser } from '../lib/auth';

/** Stand-in for the corporate SSO login page: pick a directory user, receive a signed token. */
export default function LoginPage({ onSignedIn }: { onSignedIn: (user: SessionUser) => void }) {
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();

  useEffect(() => { directory().then(setUsers).catch((e) => setError(e.message)); }, []);

  const choose = async (u: DirectoryUser) => {
    setPending(u.id);
    setError(undefined);
    try {
      onSignedIn(await signIn(u.id));
    } catch (e) {
      setError((e as Error).message);
      setPending(undefined);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-accent-deep px-4">
      <div className="rise-in w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-accent font-display text-xl font-extrabold text-white">S</div>
          <div>
            <h1 className="font-display text-xl font-extrabold tracking-tight text-ink">Sign in to SpendBoard</h1>
            <p className="text-xs text-ink-soft">Single sign-on (simulated) — choose an account</p>
          </div>
        </div>

        <div className="space-y-2.5">
          {users.map((u) => (
            <button
              key={u.id}
              onClick={() => choose(u)}
              disabled={Boolean(pending)}
              className="flex w-full items-center gap-3 rounded-xl border border-line p-3.5 text-left transition enabled:hover:border-accent/50 enabled:hover:shadow-sm disabled:opacity-60"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-sm font-bold text-accent">
                {u.name.split(' ').map((p) => p[0]).join('')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-display text-sm font-bold text-ink">{u.name}</span>
                <span className="block truncate text-xs text-ink-faint">{u.title} · {u.email}</span>
              </span>
              <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                u.role === 'admin' ? 'bg-accent text-white' : 'bg-accent-soft text-accent'
              }`}>
                {pending === u.id ? '…' : u.role}
              </span>
            </button>
          ))}
          {!users.length && !error && <p className="py-6 text-center text-sm text-ink-faint">Contacting identity provider…</p>}
        </div>
        {error && <p className="mt-4 text-sm text-negative">{error}</p>}
        <p className="mt-6 text-[11px] leading-relaxed text-ink-faint">
          The identity provider issues a signed token; the API verifies it on every request. Admins can edit the global
          library directly; analysts work in their private space.
        </p>
      </div>
    </div>
  );
}
