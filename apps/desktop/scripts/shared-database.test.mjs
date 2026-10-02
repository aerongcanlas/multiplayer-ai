import test from "node:test";
import assert from "node:assert/strict";
import { sharedDatabase, alice, bob, eve } from "./shared-fixture.mjs";

test("generated drafts are saved atomically with canonical membership and source attribution", async () => {
  const { db, rpc } = await sharedDatabase();
  try {
    const { roomId } = await rpc(alice, {
      type: "room.create",
      name: "Generated drafts",
    });
    const sent = await rpc(alice, {
      type: "message.send",
      roomId,
      text: "Support dark mode",
    });
    const message = sent.snapshot.rooms[0].messages[0];
    const command = {
      type: "suggestion.save-generated",
      roomId,
      messageIds: [message.id],
      prompts: ["Implement a theme toggle.", "Verify theme persistence."],
    };
    await assert.rejects(rpc(null, command, "anon"), /permission denied/);
    await assert.rejects(rpc(null, command), /Sign in/);
    await assert.rejects(rpc(bob, command), /no longer a member/);
    await assert.rejects(
      rpc(alice, { ...command, messageIds: [eve] }),
      /does not belong/,
    );
    await assert.rejects(
      rpc(alice, { ...command, messageIds: [message.id, message.id] }),
      /distinct/,
    );
    await assert.rejects(rpc(alice, { ...command, prompts: [] }), /1 to 3/);
    await assert.rejects(
      rpc(alice, { ...command, prompts: ["Valid", " "] }),
      /2,000/,
    );
    assert.equal((await rpc(alice)).rooms[0].suggestions.length, 0);
    const result = await rpc(alice, {
      ...command,
      userId: bob,
      sources: [{ text: "forged" }],
    });
    assert.deepEqual(
      result.snapshot.rooms[0].suggestions.map((item) => item.prompt).sort(),
      command.prompts.sort(),
    );
    for (const item of result.snapshot.rooms[0].suggestions) {
      assert.equal(item.authorId, alice);
      assert.deepEqual(item.sources, [message]);
    }
  } finally {
    await db.close();
  }
});

test("desktop rooms support current web threads while preserving service-only mutations", async () => {
  const { db, rpc } = await sharedDatabase();
  try {
    const { roomId } = await rpc(alice, {
      type: "room.create",
      name: "Both apps",
    });
    await db.exec("set role service_role");
    const first = await db.query(
      "select * from public.create_ai_thread($1, $2, $3)",
      [roomId, alice, "44444444-4444-4444-8444-444444444444"],
    );
    const second = await db.query(
      "select * from public.create_ai_thread($1, $2, $3)",
      [roomId, alice, "55555555-5555-4555-8555-555555555555"],
    );
    assert.notEqual(first.rows[0].thread_id, second.rows[0].thread_id);
    await assert.rejects(
      db.query("insert into public.ai_thread(room_id) values ($1)", [roomId]),
      /explicit thread creation identity/,
    );
    await db.exec("reset role; set role authenticated");
    await assert.rejects(
      db.query("select * from public.create_ai_thread($1, $2, $3)", [
        roomId,
        alice,
        "66666666-6666-4666-8666-666666666666",
      ]),
      /permission denied/,
    );
    await db.exec("reset role");
    assert.equal((await rpc(alice)).rooms[0].id, roomId);
  } finally {
    await db.close();
  }
});

test("desktop migration enforces shared-room identities and membership in local PostgreSQL", async () => {
  const { db, rpc } = await sharedDatabase();
  try {
    await assert.rejects(rpc(null, undefined, "anon"), /permission denied/);
    await assert.rejects(rpc(null), /Sign in/);
    const created = await rpc(alice, {
      type: "room.create",
      name: "Shared design",
    });
    const roomId = created.roomId;
    assert.equal(created.snapshot.rooms[0].isAdmin, true);
    assert.deepEqual((await rpc(bob)).rooms, []);
    await assert.rejects(
      rpc(bob, { type: "message.send", roomId, text: "Intruder" }),
      /no longer a member/,
    );
    const invite = "a".repeat(64);
    await rpc(alice, { type: "invite.create", roomId, tokenHash: invite });
    const joined = await rpc(bob, {
      type: "room.join",
      tokenHash: invite,
      userId: alice,
    });
    assert.equal(joined.snapshot.userId, bob);
    assert.equal(joined.snapshot.rooms[0].isAdmin, false);
    assert.equal(
      (await rpc(bob, { type: "room.join", tokenHash: invite })).roomId,
      roomId,
    );
    await assert.rejects(
      rpc(eve, { type: "room.join", tokenHash: invite }),
      /already been used/,
    );
    await assert.rejects(
      rpc(bob, { type: "invite.create", roomId, tokenHash: "b".repeat(64) }),
      /Only room admins/,
    );
    const sent = await rpc(bob, {
      type: "message.send",
      roomId,
      text: "Keep context visible",
      authorId: alice,
    });
    const message = sent.snapshot.rooms[0].messages[0];
    assert.equal(message.authorId, bob);
    assert.equal(message.authorName, "Bob");
    assert.equal((await rpc(alice)).rooms[0].messages[0].text, message.text);
    const other = await rpc(alice, {
      type: "room.create",
      name: "Private to Alice",
    });
    const outside = await rpc(alice, {
      type: "message.send",
      roomId: other.roomId,
      text: "Not in shared room",
    });
    const outsideMessage = outside.snapshot.rooms.find(
      (room) => room.id === other.roomId,
    ).messages[0];
    await assert.rejects(
      rpc(bob, {
        type: "suggestion.create",
        roomId,
        messageIds: [outsideMessage.id],
      }),
      /does not belong/,
    );
    const suggested = await rpc(bob, {
      type: "suggestion.create",
      roomId,
      messageIds: [message.id],
      sources: [{ text: "forged" }],
    });
    const suggestion = suggested.snapshot.rooms[0].suggestions[0];
    assert.equal(suggestion.sources[0].text, message.text);
    await rpc(bob, {
      type: "suggestion.edit",
      roomId,
      suggestionId: suggestion.id,
      prompt: "Edited",
      expectedRevision: 1,
    });
    await assert.rejects(
      rpc(bob, {
        type: "suggestion.edit",
        roomId,
        suggestionId: suggestion.id,
        prompt: "Stale",
        expectedRevision: 1,
      }),
      /changed/,
    );
    await db.query(
      "delete from public.room_member where room_id=$1 and member_id=$2",
      [roomId, bob],
    );
    assert.deepEqual((await rpc(bob)).rooms, []);
    await assert.rejects(
      rpc(bob, { type: "message.send", roomId, text: "After removal" }),
      /no longer a member/,
    );
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select * from public.desktop_prompt_suggestion"),
      /permission denied/,
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("read-along RPCs keep shared tabs host-only, member-readable, and ordered", async () => {
  const { db, rpc, call } = await sharedDatabase();
  try {
    const { roomId } = await rpc(alice, {
      type: "room.create",
      name: "Read along",
    });
    const invite = "c".repeat(64);
    await rpc(alice, { type: "invite.create", roomId, tokenHash: invite });
    await rpc(bob, { type: "room.join", tokenHash: invite });
    const tabId = "77777777-7777-4777-8777-777777777777";
    const device = "alice-desktop-1";
    const record = (patch = {}) => ({
      tabId,
      roomId,
      deviceId: device,
      title: "Fix the build",
      harness: "codex",
      model: "gpt-5",
      status: "running",
      switchOn: true,
      ...patch,
    });
    const entry = (seq, patch = {}) => ({
      seq,
      kind: "assistant",
      share: "full",
      summary: `Line ${seq}`,
      text: `Line ${seq}`,
      version: 1,
      ...patch,
    });
    const publish = (userId, tab, entries = []) =>
      call(userId, "desktop_tab_share_publish", {
        p_tab: tab,
        p_entries: entries,
      });
    const pull = (userId, args = {}) =>
      call(userId, "desktop_tab_share_pull", {
        p_tab_id: tabId,
        p_after_rev: null,
        p_after_seq: null,
        p_before_seq: null,
        p_limit: 200,
        p_byte_budget: 1048576,
        ...args,
      });

    // Covers R5: publish, pull in (rev, seq) order, matching head.
    const first = await publish(alice, record(), [
      entry(1, { kind: "user" }),
      entry(2),
      entry(3, {
        kind: "approval",
        share: "summary",
        state: "pending",
        text: undefined,
      }),
    ]);
    assert.deepEqual(first, { maxSeq: 3, version: 1, rev: 1 });
    const pulled = await pull(bob, { p_after_rev: 0, p_after_seq: 0 });
    assert.deepEqual(
      pulled.entries.map((row) => row.seq),
      [1, 2, 3],
    );
    assert.equal(pulled.record.hostName, "Alice");
    assert.equal(pulled.next, null);
    assert.ok(pulled.now);
    assert.ok(
      pulled.record.rev <= Math.max(...pulled.entries.map((row) => row.rev)),
    );
    const head = await call(alice, "desktop_tab_share_head", {
      p_tab_id: tabId,
    });
    assert.deepEqual(head, {
      maxSeq: 3,
      version: 1,
      rev: 1,
      pending: [{ seq: 3, version: 1 }],
    });

    // Covers AE10: another member or another device of the host cannot write.
    await assert.rejects(
      publish(bob, record({ deviceId: "bob-desktop-1" }), [entry(4)]),
      /Only the host device/,
    );
    await assert.rejects(
      publish(alice, record({ deviceId: "alice-desktop-2" }), [entry(4)]),
      /Only the host device/,
    );
    await assert.rejects(
      call(bob, "desktop_tab_share_head", { p_tab_id: tabId }),
      /no longer a member/,
    );
    const other = await rpc(alice, { type: "room.create", name: "Elsewhere" });
    await assert.rejects(
      publish(alice, record({ roomId: other.roomId })),
      /cannot move between rooms/,
    );
    assert.equal((await pull(bob)).record.rev, 1);

    // Covers AE17: stale versions are no-ops; a newer version updates and rev advances once per call.
    await publish(alice, record(), [entry(2, { text: "Stale", version: 1 })]);
    assert.equal(
      (await pull(bob)).entries.find((row) => row.seq === 2).text,
      "Line 2",
    );
    const grown = await publish(alice, record(), [
      entry(2, { text: "Line 2 grown", version: 2 }),
      entry(4),
    ]);
    assert.equal(grown.rev, 3);
    const delta = await pull(bob, { p_after_rev: 1, p_after_seq: 3 });
    assert.deepEqual(
      delta.entries.map((row) => [row.rev, row.seq]),
      [
        [3, 2],
        [3, 4],
      ],
    );
    assert.equal(delta.entries[0].text, "Line 2 grown");

    // An approval updated at an old seq lands above the previous head rev.
    await publish(alice, record(), [
      entry(3, {
        kind: "approval",
        share: "summary",
        state: "cancelled",
        text: undefined,
        version: 2,
      }),
    ]);
    const cancelled = await pull(bob, { p_after_rev: 3, p_after_seq: 4 });
    assert.deepEqual(
      cancelled.entries.map((row) => [row.seq, row.state, row.rev]),
      [[3, "cancelled", 4]],
    );
    assert.deepEqual(
      (await call(alice, "desktop_tab_share_head", { p_tab_id: tabId }))
        .pending,
      [],
    );

    // A byte budget cuts a page between rows and next resumes inside the same rev.
    const big = Array.from({ length: 5 }, (_, index) =>
      entry(10 + index, { text: "x".repeat(600) }),
    );
    const bulk = await publish(alice, record(), big);
    const cut = await pull(bob, {
      p_after_rev: 4,
      p_after_seq: 3,
      p_byte_budget: 1024,
    });
    assert.ok(cut.next);
    assert.ok(cut.entries.length >= 1 && cut.entries.length < 5);
    const seen = [...cut.entries];
    let next = cut.next;
    while (next) {
      const page = await pull(bob, {
        p_after_rev: next.rev,
        p_after_seq: next.seq,
        p_byte_budget: 1024,
      });
      seen.push(...page.entries);
      next = page.next;
    }
    assert.deepEqual(
      seen.map((row) => [row.rev, row.seq]),
      big.map(({ seq }) => [bulk.rev, seq]),
    );

    // History mode pages the newest rows below before_seq.
    const history = await pull(bob, { p_limit: 2 });
    assert.deepEqual(
      history.entries.map((row) => row.seq),
      [14, 13],
    );
    assert.equal(history.next.seq, 13);
    const older = await pull(bob, { p_limit: 200, p_before_seq: 13 });
    assert.deepEqual(
      older.entries.map((row) => row.seq),
      [12, 11, 10, 4, 3, 2, 1],
    );

    // Input caps and enums.
    await assert.rejects(
      publish(
        alice,
        record(),
        Array.from({ length: 201 }, (_, index) => entry(index + 100)),
      ),
      /at most 200/,
    );
    await assert.rejects(
      publish(alice, record(), [entry(5, { summary: "s".repeat(401) })]),
      /entry is invalid/,
    );
    await assert.rejects(
      publish(alice, record(), [entry(5, { source: "leak" })]),
      /entry is invalid/,
    );
    await assert.rejects(
      publish(alice, record(), [entry(5, { kind: "reasoning" })]),
      /entry is invalid/,
    );
    await assert.rejects(
      publish(alice, record(), [entry(5, { detail: "not a plan" })]),
      /entry is invalid/,
    );
    await assert.rejects(
      publish(alice, record({ status: "paused" })),
      /record is invalid/,
    );
    await assert.rejects(
      publish(alice, record({ deviceId: "bad id!" })),
      /record is invalid/,
    );
    await assert.rejects(
      pull(bob, { p_after_rev: -1, p_after_seq: 0 }),
      /negative/,
    );

    // Snapshot lists ended tabs with server time; closed tabs leave the list.
    await publish(alice, record({ status: "ended", switchOn: false }));
    const listed = (await rpc(bob)).rooms.find((room) => room.id === roomId);
    assert.deepEqual(
      listed.sharedTabs.map((tab) => [tab.tabId, tab.status, tab.hostName]),
      [[tabId, "ended", "Alice"]],
    );
    assert.ok((await rpc(bob)).now);
    assert.deepEqual(
      (await rpc(alice)).rooms.find((room) => room.id === other.roomId)
        .sharedTabs,
      [],
    );

    // Reconcile closes only this device's rows missing from the live list.
    const secondTab = "88888888-8888-4888-8888-888888888888";
    const otherDevice = "99999999-9999-4999-8999-999999999999";
    await publish(alice, record({ tabId: secondTab }));
    await publish(
      alice,
      record({ tabId: otherDevice, deviceId: "alice-desktop-2" }),
    );
    await call(alice, "desktop_tab_share_reconcile", {
      p_device_id: device,
      p_live_tab_ids: [secondTab],
    });
    const reconciled = (await rpc(bob)).rooms.find(
      (room) => room.id === roomId,
    ).sharedTabs;
    assert.deepEqual(
      reconciled.map((tab) => tab.tabId).sort(),
      [secondTab, otherDevice].sort(),
    );
    assert.equal((await pull(bob)).record.status, "closed");
    await assert.rejects(
      call(alice, "desktop_tab_share_reconcile", {
        p_device_id: "x",
        p_live_tab_ids: [],
      }),
      /invalid/,
    );

    // Covers R11, AE7: outsiders and removed hosts get 42501; the removed host leaves the list.
    await assert.rejects(pull(eve), /not shared with you/);
    await assert.rejects(
      publish(eve, record({ deviceId: "eve-desktop-1" })),
      /no longer a member/,
    );
    await db.query(
      "delete from public.room_member where room_id=$1 and member_id=$2",
      [roomId, alice],
    );
    await assert.rejects(
      publish(alice, record({ tabId: secondTab })),
      /no longer a member/,
    );
    assert.deepEqual((await rpc(bob)).rooms[0].sharedTabs, []);
    await assert.rejects(
      call(alice, "desktop_tab_share_head", { p_tab_id: secondTab }),
      /no longer a member/,
    );

    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select * from public.desktop_tab_share"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select * from public.desktop_tab_share_entry"),
      /permission denied/,
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("read-along RPCs store sub-agent cards and the plan record, and pull them by kind", async () => {
  const { db, rpc, call } = await sharedDatabase();
  try {
    const { roomId } = await rpc(alice, {
      type: "room.create",
      name: "Spectators",
    });
    const invite = "d".repeat(64);
    await rpc(alice, { type: "invite.create", roomId, tokenHash: invite });
    await rpc(bob, { type: "room.join", tokenHash: invite });
    const tabId = "77777777-7777-4777-8777-777777777777";
    const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const record = (patch = {}) => ({
      tabId,
      roomId,
      deviceId: "alice-desktop-1",
      title: "Fix the build",
      harness: "claude",
      model: "opus",
      status: "running",
      switchOn: true,
      ...patch,
    });
    const agent = (patch = {}) => ({
      key: "agent-1",
      parentKey: "agent-0",
      name: "explorer",
      type: "Explore",
      status: "running",
      background: false,
      startedAt: "2026-10-02T00:00:00.000Z",
      toolUses: 2,
      latestTool: "Read src/index.ts",
      turnId,
      ...patch,
    });
    const card = (seq, patch = {}, entry = {}) => ({
      seq,
      kind: "agent",
      share: "full",
      summary: "Map the codebase",
      version: 1,
      agent: agent(patch),
      ...entry,
    });
    const line = (seq) => ({
      seq,
      kind: "assistant",
      share: "full",
      summary: `Line ${seq}`,
      text: `Line ${seq}`,
      version: 1,
    });
    const publish = (userId, tab, entries = []) =>
      call(userId, "desktop_tab_share_publish", {
        p_tab: tab,
        p_entries: entries,
      });
    const pull = (userId, args = {}) =>
      call(userId, "desktop_tab_share_pull", {
        p_tab_id: tabId,
        p_after_rev: 0,
        p_after_seq: 0,
        p_before_seq: null,
        p_limit: 200,
        p_byte_budget: 1048576,
        ...args,
      });
    const head = () =>
      call(alice, "desktop_tab_share_head", { p_tab_id: tabId });

    // Happy path, turn: a full card round-trips with its agent object and turn.
    await publish(alice, record(), [line(1), card(2)]);
    const stored = (await pull(bob)).entries.find((row) => row.seq === 2);
    assert.equal(stored.kind, "agent");
    assert.deepEqual(stored.agent, agent());
    assert.equal(stored.agent.turnId, turnId);

    // Record: omitted fields stay null; published ones return in the pull's record and the snapshot.
    const bare = (await pull(bob)).record;
    assert.deepEqual(
      [bare.plan, bare.runningAgents, bare.reportsAgents],
      [null, null, null],
    );
    const plan = {
      explanation: "Two steps",
      steps: [
        { text: "Read the code", status: "done" },
        { text: "Fix it", status: "active" },
      ],
    };
    await publish(
      alice,
      record({ plan, runningAgents: 1, reportsAgents: true }),
    );
    const full = (await pull(bob)).record;
    assert.deepEqual(full.plan, plan);
    assert.equal(full.runningAgents, 1);
    assert.equal(full.reportsAgents, true);
    const listed = (await rpc(bob)).rooms[0].sharedTabs[0];
    assert.deepEqual(listed.plan, plan);
    assert.equal(listed.reportsAgents, true);
    await publish(alice, record({ reportsAgents: false }));
    const cleared = (await pull(bob)).record;
    assert.deepEqual(
      [cleared.plan, cleared.runningAgents, cleared.reportsAgents],
      [null, null, false],
    );

    // Plan size and record field types.
    for (const bad of [
      { plan: { steps: Array(51).fill({ text: "s", status: "done" }) } },
      { plan: { steps: [{ text: "x".repeat(301), status: "done" }] } },
      { plan: { steps: [{ text: "s", status: "blocked" }] } },
      { plan: { steps: [{ text: "s", status: "done", extra: 1 }] } },
      { plan: { steps: [], explanation: "e".repeat(1001) } },
      { plan: { steps: [], turnId } },
      { plan: [] },
      { runningAgents: -1 },
      { runningAgents: 1.5 },
      { reportsAgents: "yes" },
    ])
      await assert.rejects(
        publish(alice, record(bad)),
        /record is invalid/,
        JSON.stringify(bad).slice(0, 80),
      );

    // Edge: a running mid-run card without endedAt; versions stay monotonic.
    await publish(alice, record(), [
      card(3, { key: "agent-2", joinedMidRun: true, parentKey: undefined }),
    ]);
    await publish(alice, record(), [
      card(
        3,
        {
          key: "agent-2",
          joinedMidRun: true,
          status: "completed",
          endedAt: "2026-10-02T00:01:00.000Z",
        },
        { version: 3, text: "Found it" },
      ),
    ]);
    await publish(alice, record(), [
      card(3, { key: "agent-2", status: "failed" }, { version: 2 }),
    ]);
    const settled = (await pull(bob)).entries.find((row) => row.seq === 3);
    assert.equal(settled.agent.status, "completed");
    assert.equal(settled.agent.joinedMidRun, true);
    assert.equal(settled.text, "Found it");
    assert.equal(settled.version, 3);

    // Head: running cards are seeds beside pending approvals; settled cards are not.
    await publish(alice, record(), [
      {
        seq: 4,
        kind: "approval",
        share: "summary",
        summary: "Run tests",
        state: "pending",
        version: 1,
      },
    ]);
    assert.deepEqual((await head()).pending, [
      { seq: 2, version: 1 },
      { seq: 4, version: 1 },
    ]);

    // Errors: malformed cards, and a card on another kind or a card entry without one.
    for (const bad of [
      card(5, { status: "paused" }),
      card(5, { latestTool: "t".repeat(401) }),
      card(5, { model: "leak" }),
      card(5, { turnId: "not-a-turn" }),
      card(5, { key: "" }),
      card(5, { toolUses: -1 }),
      card(5, { background: "no" }),
      card(5, { joinedMidRun: "yes" }),
      card(5, {}, { summary: "s".repeat(401) }),
      card(5, {}, { agent: "card" }),
      card(5, {}, { agent: undefined }),
      { ...line(5), agent: agent() },
    ])
      await assert.rejects(
        publish(alice, record(), [bad]),
        /entry is invalid/,
        JSON.stringify(bad).slice(0, 120),
      );

    // Integration: no kinds argument returns every kind; a filter keeps only its kinds.
    const kindsOf = async (args) =>
      (await pull(bob, args)).entries.map((row) => row.kind);
    assert.deepEqual(await kindsOf({}), [
      "assistant",
      "agent",
      "agent",
      "approval",
    ]);
    assert.deepEqual(await kindsOf({ p_kinds: ["agent"] }), ["agent", "agent"]);
    assert.deepEqual(await kindsOf({ p_kinds: ["assistant", "approval"] }), [
      "assistant",
      "approval",
    ]);
    assert.deepEqual(
      await kindsOf({ p_kinds: ["agent"], p_after_rev: null, p_limit: 1 }),
      ["agent"],
    );
    await assert.rejects(
      pull(bob, { p_kinds: Array(21).fill("agent") }),
      /Too many/,
    );

    // Compatibility: one pull function, and the shipped six-argument call still resolves to it.
    const overloads = await db.query(
      "select count(*)::int as count from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'desktop_tab_share_pull'",
    );
    assert.equal(overloads.rows[0].count, 1);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      bob,
    ]);
    await db.exec("set role authenticated");
    const positional = await db.query(
      "select public.desktop_tab_share_pull($1::uuid, 0::bigint, 0, null, 200, 1048576) as data",
      [tabId],
    );
    await db.exec("reset role");
    assert.equal(positional.rows[0].data.entries.length, 4);

    // Host-only writes: another account or device publishing cards is still refused.
    await assert.rejects(
      publish(bob, record({ deviceId: "bob-desktop-1" }), [card(6)]),
      /Only the host device/,
    );
    await assert.rejects(
      publish(alice, record({ deviceId: "alice-desktop-2" }), [card(6)]),
      /Only the host device/,
    );
    await assert.rejects(
      publish(eve, record({ deviceId: "eve-desktop-1" }), [card(6)]),
      /no longer a member/,
    );
    assert.equal((await pull(bob)).entries.length, 4);
  } finally {
    await db.close();
  }
});
