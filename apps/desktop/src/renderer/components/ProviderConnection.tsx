import { Bot, RefreshCw } from "lucide-react";
import type { ProviderState } from "../../shared/provider";
import { perform } from "../lib/desktop-store";
import { Button } from "./ui/Button";

export function ProviderConnection({
  provider,
  disabled,
  active,
}: {
  provider?: ProviderState;
  disabled: boolean;
  active: boolean;
}) {
  const connected = provider?.status === "connected";
  return (
    <section
      className="shared-connection provider-connection"
      aria-label="ChatGPT connection"
    >
      <div className="shared-account-heading">
        <Bot size={15} />
        <strong>ChatGPT {connected ? provider.account?.plan : "agents"}</strong>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh ChatGPT connection"
          disabled={disabled}
          onClick={() => void perform(() => window.desktop.refreshProvider())}
        >
          <RefreshCw size={13} />
        </Button>
      </div>
      {connected ? (
        <>
          <span className="provider-account" title={provider.account?.label}>
            {provider.account?.label}
          </span>
          <details>
            <summary>Usage and account</summary>
            {provider.limits.length ? (
              provider.limits.map((limit) => (
                <p key={limit.name}>
                  {Math.round(100 - limit.usedPercent)}% remaining ·{" "}
                  {limit.name}
                </p>
              ))
            ) : (
              <p>Usage information unavailable.</p>
            )}
            <p>
              Shared with your other Codex sessions. Disconnect signs out of
              local Codex.
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || active}
              onClick={() =>
                void perform(() => window.desktop.disconnectProvider())
              }
            >
              Disconnect ChatGPT
            </Button>
          </details>
        </>
      ) : provider?.status === "signing_in" ? (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            void perform(() => window.desktop.cancelProviderLogin())
          }
        >
          Cancel ChatGPT sign-in
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void perform(() => window.desktop.connectProvider())}
        >
          Connect ChatGPT
        </Button>
      )}
      {!connected && (
        <p role="status">
          {provider?.message ??
            "Use your ChatGPT subscription for the lead and specialists."}
        </p>
      )}
    </section>
  );
}
