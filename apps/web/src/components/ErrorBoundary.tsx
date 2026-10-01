import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps one broken page from blanking the whole app; resets when `resetKey` (the route) changes. */
export default class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="px-10 py-16">
        <div className="max-w-xl rounded-2xl border border-negative/30 bg-white p-6 shadow-sm">
          <h1 className="font-display text-lg font-bold text-ink">Something went wrong on this page</h1>
          <p className="mt-1 text-sm text-ink-soft">The rest of the app still works — go back or pick another page.</p>
          <pre className="mt-4 overflow-auto rounded-lg bg-canvas p-3 font-mono text-xs text-negative">{this.state.error.message}</pre>
          <button onClick={() => this.setState({ error: null })} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-deep">
            Try again
          </button>
        </div>
      </div>
    );
  }
}
