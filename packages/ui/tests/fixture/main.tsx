import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/chat/composer";
import { MessageList } from "../../src/chat/message-list";
import { RoomWorkspace } from "../../src/layouts/room-workspace";
import { ThreadWelcome } from "../../src/ai/thread-welcome";
import { Button } from "../../src/primitives/button";
import { SidebarProvider, useSidebar } from "../../src/primitives/sidebar";
import type { SubmissionResult } from "../../src/chat/composer-state";
import "./style.css";

function SidebarToggle() {
  const { open, toggleSidebar } = useSidebar();
  return (
    <Button onClick={toggleSidebar}>Sidebar {open ? "open" : "closed"}</Button>
  );
}

function Fixture() {
  const compact = new URLSearchParams(location.search).has("compact");
  const [drafts, setDrafts] = useState<
    Record<string, { value: string; revision: number }>
  >({ a: { value: "", revision: 0 }, b: { value: "", revision: 0 } });
  const [target, setTarget] = useState("a");
  const [sent, setSent] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [persisted, setPersisted] = useState("none");
  const pending = useRef<{
    resolve(result: SubmissionResult): void;
    reject(reason: Error): void;
  } | null>(null);
  const draft = drafts[target]!;
  function settle(accepted: boolean) {
    pending.current?.resolve({ accepted });
    pending.current = null;
  }
  return (
    <SidebarProvider
      onPersistOpen={(open) => setPersisted(String(open))}
      className="block"
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <SidebarToggle />
        <Button onClick={() => setTarget(target === "a" ? "b" : "a")}>
          Switch room
        </Button>
        <Button onClick={() => settle(true)}>Accept</Button>
        <Button onClick={() => settle(false)}>Reject</Button>
        <Button
          onClick={() => {
            pending.current?.reject(new Error("fixture failure"));
            pending.current = null;
          }}
        >
          Fail
        </Button>
        <output aria-label="Current room">{target}</output>
        <output aria-label="Submissions">{sent}</output>
        <output aria-label="Persisted sidebar">{persisted}</output>
        <output aria-label="Selection count">{selected.size}</output>
      </div>
      <div className={compact ? "h-[760px]" : undefined}>
        <RoomWorkspace
          mode={compact ? "window" : "page"}
          aiPanel={
            <section
              aria-label="Activity fixture"
              className="flex h-full flex-col p-4"
            >
              <ThreadWelcome />
              <Composer
                targetKey={target}
                value={draft.value}
                revision={compact ? undefined : draft.revision}
                appearance={compact ? "compact" : "default"}
                maxLength={compact ? 8000 : 4000}
                lengthUnit={compact ? "code-units" : "code-points"}
                controls={<span className="text-xs">Fixture transport</span>}
                onValueChange={(value) =>
                  setDrafts((current) => ({
                    ...current,
                    [target]: {
                      value,
                      revision: current[target]!.revision + 1,
                    },
                  }))
                }
                onSubmit={() => {
                  setSent((count) => count + 1);
                  return new Promise((resolve, reject) => {
                    pending.current = { resolve, reject };
                  });
                }}
              />
            </section>
          }
          memberChatPanel={
            <section
              aria-label="Chat fixture"
              className="h-full overflow-auto p-4"
            >
              <h2 className="mb-4 text-lg">Team conversation</h2>
              <MessageList
                appearance={compact ? "compact" : "default"}
                showAvatars={!compact}
                messages={[
                  {
                    id: "one",
                    text: "Keep the draft until the host accepts it.",
                    author: { name: "Alex" },
                    isOwn: true,
                  },
                  {
                    id: "two",
                    text: "Select this message to discuss the implementation.",
                    author: { name: "Sam" },
                    isOwn: false,
                  },
                  {
                    id: "pending",
                    text: "Pending message",
                    author: { name: "Alex" },
                    isOwn: true,
                    deliveryStatus: "sending",
                  },
                  {
                    id: "failed",
                    text: "Retry needed",
                    author: { name: "Alex" },
                    isOwn: true,
                    deliveryStatus: "failed",
                  },
                ]}
                selectedMessageIds={selected}
                onMessageSelect={(id, checked) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (checked) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
              />
            </section>
          }
          promptPanel={
            <section aria-label="Prompt fixture" className="h-full p-4">
              <h2 className="text-lg">Review directions</h2>
              <p className="mt-2 text-sm text-white/60">
                App-specific actions are supplied through props.
              </p>
            </section>
          }
        />
      </div>
    </SidebarProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
