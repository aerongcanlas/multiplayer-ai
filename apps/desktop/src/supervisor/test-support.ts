import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { Journal } from "./journal";
import { SupervisorService } from "./service";
import { inspectWorkspace } from "./workspace";
import { Accounts } from "./harnesses/accounts";
import { HarnessRegistry } from "./harnesses/registry";
import { FakeHarness } from "./harnesses/fake";
import type { HarnessAdapter } from "./harnesses/contract";
import { ProgramManager } from "./programs/manager";
import { HARNESS_MANIFEST } from "./programs/manifest";
import type { Snapshot, SupervisorRequest } from "../shared/contracts";
import type {
  HarnessId,
  Loadout,
  TranscriptBatch,
  TranscriptEntry,
} from "../shared/tabs";

type Command = SupervisorRequest["command"];
const BUSY = ["running", "awaiting_host"];

export async function repository() {
  const dir = await mkdtemp(join(tmpdir(), "multiplayer-tabs-"));
  const repo = join(dir, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  );
  // The fake harness runs as a custom executable, so nothing is downloaded.
  const executable = join(dir, "fake-harness");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  return { dir, repo, executable };
}

export type Setup = Awaited<ReturnType<typeof start>>;
/** A service over a fresh repository, or over `paths` from an earlier start to simulate a restart. */
export async function start(
  fake: FakeHarness,
  paths?: { dir: string; repo: string; executable: string },
  // More adapters beside the fake, each run as the same custom executable.
  others: HarnessAdapter[] = [],
) {
  const { dir, repo, executable } = paths ?? (await repository());
  const journal = new Journal(join(dir, "journal.sqlite"));
  for (const adapter of [fake, ...others])
    journal.setSetting(`harness.${adapter.id}.executable`, executable);
  const batches: TranscriptBatch[] = [];
  // Snapshots and transcript batches in the order the supervisor emitted them.
  const emitted: (
    | { kind: "snapshot"; snapshot: Snapshot }
    | { kind: "batch"; batch: TranscriptBatch }
  )[] = [];
  let changed = () => {};
  const registry = new HarnessRegistry({
    adapters: [fake, ...others],
    programs: new ProgramManager({ root: dir, manifest: HARNESS_MANIFEST }),
    accounts: new Accounts(join(dir, "accounts")),
    settings: journal,
    changed: () => changed(),
    environmentTimeoutMs: 0,
  });
  registry.setEnvironment({ PATH: process.env.PATH ?? "" });
  const service = new SupervisorService(
    journal,
    (snapshot) => emitted.push({ kind: "snapshot", snapshot }),
    {
      registry,
      publishTranscript: (items) => {
        batches.push(...items);
        for (const batch of items) emitted.push({ kind: "batch", batch });
      },
      transcriptInterval: 5,
      stopTimeoutMs: 300,
    },
  );
  changed = () => service.harnessesChanged();
  await registry.refresh(fake.id);
  const roomId = service.snapshot().rooms[0].id;
  if (!paths)
    await service.dispatch({
      type: "workspace.register",
      roomId,
      workspace: await inspectWorkspace(repo),
    });
  const dispatch = (command: Command) => service.dispatchResult(command);
  const tabs = (room = roomId) =>
    service.snapshot().rooms.find((item) => item.id === room)!.tabs;
  const tab = (id: string, room = roomId) =>
    tabs(room).find((tab) => tab.id === id)!;
  const open = async () => {
    await dispatch({ type: "tab.open", roomId, harness: fake.id });
    return tabs().at(-1)!;
  };
  const entries = async (command: Command) =>
    (await dispatch(command)).transcript!.entries;
  const transcript = (tabId: string): Promise<TranscriptEntry[]> =>
    entries({ type: "tab.transcript", roomId, tabId });
  const agents = (tabId: string): Promise<TranscriptEntry[]> =>
    entries({ type: "tab.agents", roomId, tabId });
  const agentTranscript = (
    tabId: string,
    agentKey: string,
  ): Promise<TranscriptEntry[]> =>
    entries({ type: "tab.transcript", roomId, tabId, agentKey });
  const until = async (
    check: () => boolean | Promise<boolean>,
    label: string,
  ) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await check()) return;
      await wait(10);
    }
    throw new Error(`Timed out waiting for ${label}.`);
  };
  const settled = (tabId: string, room = roomId) =>
    until(() => !BUSY.includes(tab(tabId, room).status), "turn end");
  const send = (
    tabId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => dispatch({ type: "tab.send", roomId, tabId, text, ...extra } as Command);
  /** The pending entry of `kind` in the lead's transcript, or in `agent`'s. */
  const pending = async (tabId: string, kind: string, agent?: string) => {
    let found: TranscriptEntry | undefined;
    await until(
      async () => {
        const source = agent
          ? agentTranscript(tabId, agent)
          : transcript(tabId);
        found = (await source).find(
          (entry) => entry.kind === kind && entry.state === "pending",
        );
        return Boolean(found);
      },
      `pending ${kind}${agent ? ` from ${agent}` : ""}`,
    );
    return found!;
  };
  const card = async (tabId: string, key: string) =>
    (await agents(tabId)).find((entry) => entry.agent?.key === key);
  const respond = (
    tabId: string,
    approvalId: string,
    decision: "accept" | "decline" = "accept",
  ) =>
    dispatch({ type: "approval.respond", roomId, tabId, approvalId, decision });
  const answer = (
    tabId: string,
    questionId: string,
    answers: Record<string, string[]>,
  ) =>
    dispatch({ type: "question.answer", roomId, tabId, questionId, answers });
  const stopTab = (tabId: string) =>
    dispatch({ type: "tab.stop", roomId, tabId });
  const closeTab = (tabId: string, confirm?: true) =>
    dispatch({ type: "tab.close", roomId, tabId, confirm });
  const resetSession = (tabId: string) =>
    dispatch({ type: "tab.resetSession", roomId, tabId });
  const setLoadout = (tabId: string, loadout: Loadout) =>
    dispatch({ type: "tab.setLoadout", roomId, tabId, loadout });
  return {
    dir,
    repo,
    executable,
    journal,
    service,
    registry,
    fake,
    batches,
    emitted,
    roomId,
    dispatch,
    tabs,
    tab,
    open,
    transcript,
    agents,
    agentTranscript,
    until,
    settled,
    send,
    pending,
    card,
    respond,
    answer,
    stopTab,
    closeTab,
    resetSession,
    setLoadout,
    close: () => service.close(),
  };
}

type FakeOptions = { id?: HarnessId } & NonNullable<
  ConstructorParameters<typeof FakeHarness>[1]
>;
type Body = (setup: Setup, fake: FakeHarness) => Promise<void>;
/** Runs `body` against a started service with a fake harness, closing the service afterwards. */
export async function withHost(body: Body): Promise<void>;
export async function withHost(options: FakeOptions, body: Body): Promise<void>;
export async function withHost(options: FakeOptions | Body, body?: Body) {
  if (typeof options === "function") return withHost({}, options);
  const { id = "codex", ...rest } = options;
  const fake = new FakeHarness(id, rest);
  const setup = await start(fake);
  try {
    await body!(setup, fake);
  } finally {
    setup.close();
  }
}
