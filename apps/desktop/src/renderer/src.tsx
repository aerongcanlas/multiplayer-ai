import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { connectDesktop } from "./lib/desktop-store";
import { connectTranscripts } from "./lib/transcript-store";
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
const disconnectTranscripts = connectTranscripts();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    disconnect();
    disconnectTranscripts();
  });
// macOS insets its window buttons into the app bar, which leaves room for them.
if (navigator.userAgent.includes("Macintosh"))
  document.documentElement.classList.add("platform-mac");
// A press inside the transcript or the chat messages keeps the selection it starts in that
// region, so a drag never runs from one into the other.
document.addEventListener(
  "mousedown",
  (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const region = target?.closest(".transcript")
      ? "transcript"
      : target?.closest(".chat-messages")
        ? "chat"
        : null;
    const root = document.documentElement;
    if (!region || root.dataset.selectRegion === region) return;
    getSelection()?.removeAllRanges();
    root.dataset.selectRegion = region;
  },
  true,
);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
