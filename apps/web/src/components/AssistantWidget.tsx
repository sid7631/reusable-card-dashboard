import { useEffect, useRef, useState } from 'react';
import { api, type AssistantAction, type AssistantAsk, type AssistantReply } from '../lib/api';
import { useAssistantConfig } from '../lib/queries';
import type { AppliedFilters, DashboardItem } from '../lib/types';

const SUGGESTIONS = [
  'What is total spend right now?',
  'Which segment is performing best?',
  'What is growing fastest?',
  'Show me the top 3 merchants',
  'Is spend concentrated or spread out?',
  'What am I looking at?',
];

type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; reply: AssistantReply }
  | { role: 'error'; text: string };

const ChatIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7.9 20A9 9 0 104 16.1L2 22z" />
  </svg>
);

/** Brings a cited card into view and flashes it. */
function revealCard(itemId: string) {
  const el = document.getElementById(`card-${itemId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('assistant-flash');
  setTimeout(() => el.classList.remove('assistant-flash'), 1600);
}

/**
 * Floating dashboard assistant. Questions are answered from the cards as currently shown (same
 * filters and cached results), offline or by the configured OpenAI-format model with server-side tools.
 */
export default function AssistantWidget({ dashboardId, dashboardName, items, applied, filterSummary, onApplyFilter }: {
  dashboardId: number;
  dashboardName: string;
  items: DashboardItem[];
  applied: AppliedFilters;
  filterSummary: string;
  onApplyFilter: (filterId: string, values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const config = useAssistantConfig(open).data;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // A different dashboard is a different conversation
  useEffect(() => { setMessages([]); }, [dashboardId]);

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    const history: AssistantAsk['history'] = messages.flatMap((m): AssistantAsk['history'] =>
      m.role === 'user' ? [{ role: 'user', content: m.text }]
        : m.role === 'assistant' ? [{ role: 'assistant', content: m.reply.answer }] : []);
    setMessages((ms) => [...ms, { role: 'user', text: q }]);
    setBusy(true);
    try {
      const reply = await api.askAssistant(dashboardId, {
        question: q,
        history,
        items: items.filter((i) => i.item_id).map((i) => ({ item_id: i.item_id!, filters: applied.dims, date_from: applied.from, date_to: applied.to })),
        filter_summary: filterSummary,
      });
      setMessages((ms) => [...ms, { role: 'assistant', reply }]);
    } catch (e) {
      setMessages((ms) => [...ms, { role: 'error', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const apply = (a: AssistantAction) => onApplyFilter(a.filter_id, a.values);
  const footer = config?.mode === 'llm'
    ? `Answers from this dashboard's data · ${config.model} · queries run with your access`
    : 'Reads the data already on screen · no model calls';

  return (
    <>
      {open && (
        <section role="dialog" aria-label="Dashboard assistant"
          className="rise-in fixed bottom-24 right-6 z-50 flex max-h-[min(640px,calc(100vh-8rem))] w-[min(400px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-2xl">
          <header className="flex items-center gap-3 bg-accent-deep px-4 py-3 text-white">
            <span className="flex size-9 items-center justify-center rounded-lg bg-white/10"><ChatIcon /></span>
            <div className="min-w-0 flex-1">
              <p className="font-display text-sm font-bold">Dashboard assistant</p>
              <p className="truncate text-[11px] text-sky-200/80">{filterSummary}</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close assistant" className="rounded-lg p-1.5 text-sky-200/80 transition hover:bg-white/10 hover:text-white">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {!messages.length && (
              <>
                <div className="rounded-2xl rounded-tl-md bg-canvas px-4 py-3 text-sm leading-relaxed text-ink">
                  I can answer questions about the {items.length} cards on <span className="font-bold">{dashboardName}</span>, using the
                  figures currently on screen. Ask me anything, or start with one of these.
                </div>
                <div className="space-y-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => send(s)}
                      className="block w-full rounded-xl border border-line px-3.5 py-2.5 text-left text-sm text-ink transition hover:border-accent/50 hover:bg-accent-soft">
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}

            {messages.map((m, i) => m.role === 'user' ? (
              <div key={i} className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white">{m.text}</div>
            ) : m.role === 'error' ? (
              <div key={i} className="rounded-2xl rounded-tl-md bg-negative/5 px-4 py-3 text-sm text-negative">{m.text}</div>
            ) : (
              <div key={i} className="space-y-2">
                <div className="whitespace-pre-wrap rounded-2xl rounded-tl-md bg-canvas px-4 py-3 text-sm leading-relaxed text-ink">{m.reply.answer}</div>
                {m.reply.sources.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 px-1">
                    <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-faint">From</span>
                    {m.reply.sources.map((s) => (
                      <button key={s.item_id} onClick={() => revealCard(s.item_id)} title="Show this card"
                        className="rounded-md bg-canvas px-2 py-0.5 text-[11px] font-semibold text-ink-soft transition hover:bg-accent-soft hover:text-accent">
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}
                {m.reply.actions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-1">
                    {m.reply.actions.map((a) => (
                      <button key={a.label} onClick={() => apply(a)}
                        className="rounded-lg border border-accent px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent-soft">
                        {a.label}
                      </button>
                    ))}
                  </div>
                )}
                {m.reply.tool_calls.length > 0 && (
                  <p className="px-1 text-[10px] text-ink-faint" title={JSON.stringify(m.reply.tool_calls, null, 1)}>
                    Ran {m.reply.tool_calls.length} quer{m.reply.tool_calls.length === 1 ? 'y' : 'ies'}: {[...new Set(m.reply.tool_calls.map((t) => t.tool))].join(', ')}
                  </p>
                )}
              </div>
            ))}
            {busy && (
              <div className="flex w-16 items-center justify-center gap-1 rounded-2xl rounded-tl-md bg-canvas px-4 py-3">
                {[0, 1, 2].map((d) => <span key={d} className="copilot-dot size-1.5 rounded-full bg-ink-soft" />)}
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="border-t border-line p-3">
            <div className="flex gap-2">
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about this dashboard…" maxLength={2000}
                className="w-full rounded-xl border border-line px-3.5 py-2.5 text-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20" />
              <button type="submit" disabled={busy || !input.trim()}
                className="shrink-0 rounded-xl bg-accent px-4 text-sm font-bold text-white transition enabled:hover:bg-accent-deep disabled:opacity-40">
                Ask
              </button>
            </div>
            <p className="mt-2 text-center text-[10px] text-ink-faint">{footer}</p>
          </form>
        </section>
      )}

      <button onClick={() => setOpen((o) => !o)} aria-label={open ? 'Close assistant' : 'Open dashboard assistant'}
        className={`fixed bottom-6 right-6 z-50 flex size-14 items-center justify-center rounded-full text-white shadow-xl transition hover:scale-105 ${open ? 'bg-accent-deep' : 'bg-accent'}`}>
        {open
          ? <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>
          : <ChatIcon />}
      </button>
    </>
  );
}
