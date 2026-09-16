import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { connectDesktop } from "./lib/desktop-store";
import "./globals.css";
import "./desktop.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="loading-screen">
          <h1>The interface could not render.</h1>
          <p>
            Your work is recorded in the local journal. Reload the window to
            reconnect.
          </p>
          <button onClick={() => location.reload()}>Reload window</button>
        </main>
      );
    return this.props.children;
  }
}

const disconnect = connectDesktop();
if (import.meta.hot) import.meta.hot.dispose(disconnect);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
