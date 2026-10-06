import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { loadRecording } from './persist';

/**
 * Demo recorder — capture a guided walkthrough of the app and export it as a self-contained HTML reel.
 *
 * Self-contained feature: the app mounts <DemoRecorder /> once (in the sidebar) and nothing else
 * depends on this folder. To remove it, delete `src/features/demo-recorder/` and that one line (plus
 * its import) in App.tsx. To switch it off without removing it, build with VITE_DEMO_RECORDER=false.
 * The session UI, capture and export code load only when someone starts recording.
 */

const ENABLED = import.meta.env.VITE_DEMO_RECORDER !== 'false';
// Compile-time constant: with the flag off, the bundler drops the session chunk entirely
const RecorderSession = ENABLED ? lazy(() => import('./RecorderSession')) : () => null;

export default function DemoRecorder({ collapsed }: { collapsed: boolean }) {
  const { user } = useAuth();
  const userKey = `user:${user.sub}`;
  const [active, setActive] = useState(false);

  // A recording in progress (this browser, this user) resumes after a reload or re-login
  useEffect(() => {
    if (!ENABLED) return;
    let alive = true;
    loadRecording(userKey).then((r) => alive && r && setActive(true));
    return () => { alive = false; };
  }, [userKey]);

  if (!ENABLED) return null;
  return (
    <>
      <button type="button" onClick={() => setActive(true)} disabled={active}
        title={active ? 'Recording — use the recorder bar' : 'Record a demo: capture screens and export a walkthrough reel'}
        className={`flex w-full items-center gap-2.5 rounded-xl py-2 font-display text-xs font-semibold transition ${
          collapsed ? 'justify-center px-0' : 'px-3'
        } ${active ? 'bg-red-500/15 text-red-200' : 'text-sky-200/70 hover:bg-white/5 hover:text-white'}`}>
        <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${active ? 'border-red-400' : 'border-current'}`}>
          <span className={`size-1.5 rounded-full ${active ? 'animate-pulse bg-red-400' : 'bg-current'}`} />
        </span>
        {!collapsed && (active ? 'Recording…' : 'Record demo')}
      </button>
      {active && (
        <Suspense fallback={null}>
          <RecorderSession userKey={userKey} author={user.name} onEnded={() => setActive(false)} />
        </Suspense>
      )}
    </>
  );
}
