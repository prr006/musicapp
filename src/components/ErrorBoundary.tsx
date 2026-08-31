/** Last-resort UI error boundary (spec §29: never a blank window). */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[melo] UI error:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="state-block" style={{ height: "100vh" }}>
          <div className="big">⚠</div>
          <h3>Something broke in the interface</h3>
          <p>
            Playback keeps running — this is a display problem.
            Reload the window to recover. Details: {String(this.state.error.message)}
          </p>
          <button className="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
