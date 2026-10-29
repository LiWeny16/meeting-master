import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Last line of defence: a render crash must not leave a white window with no
 * explanation and no way out.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept visible in the dev console; a packaged build ships the same text on screen.
    console.error('[Meeting Master] render failure', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <h1>Something broke while drawing this screen.</h1>
        <p>The assistant and any recording keep running. Reload to recover.</p>
        <pre>{error.message}</pre>
        <div className="crash-actions">
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
          <button
            type="button"
            onClick={() => { void navigator.clipboard?.writeText(`${error.message}\n${error.stack ?? ''}`); }}
          >
            Copy details
          </button>
          <button type="button" onClick={() => this.setState({ error: null })}>Dismiss</button>
        </div>
      </div>
    );
  }
}
