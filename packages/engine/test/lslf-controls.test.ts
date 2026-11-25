import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  answerQuestion,
  autonomySettings,
  drainOutbox,
  getAgent,
  LSLF_AGENT_KEYS,
  LSLF_WORKSPACE_KEYS,
  type LslfServerSettings,
  lslfControls,
  lslfServerSettings,
  parseWorkspaceSet,
  postPersonMessage,
  RUN_CONTROLS_STEP_KEY,
  resolveAgentControls,
  resolveWorkspaceControls,
  runControls,
  STEADY_AGENT_CONTROLS,
  STEADY_WORKSPACE_CONTROLS,
  STOCK_AGENT_CONTROLS,
  STOCK_WORKSPACE_CONTROLS,
  updateAgent,
} from "../src";
import { chosenAutonomy } from "../src/autonomy-settings";
import { type Fixture, setup } from "./fixtures";

/**
 * Agent controls, the foundation (ADR 0186): the validator, the resolution order, the brakes save that keeps them,
 * the run that records them once, and proof that no behaviour reads them yet.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000002";
const server = (s: Partial<LslfServerSettings>): LslfServerSettings => ({
  preset: "stock",
  orgs: null,
  workspaceSet: {},
  ...s,
});

/** Names a safeguard might go by. None is a control, so none can be set off. */
const SAFEGUARDS = [
  "secret",
  "secretCheck",
  "approvals",
  "approvalsLevel",
  "approvalCards",
  "runPolicy",
  "permissions",
  "budget",
  "budgetCheck",
  "stepCap",
  "maxToolTurns",
  "maxHops",
  "followUpWork",
  "waitDetach",
  "teamActionCheck",
  "standing",
  "audience",
  "untrusted",
  "forSamePerson",
];

describe("lslfControls: the validator", () => {
  test("nothing, or something that isn't an object, is empty", () => {
    for (const raw of [undefined, null, 1, "steady", [], true]) expect(lslfControls(raw)).toEqual({});
  });

  test("keeps a known preset and good values, as given", () => {
    expect(
      lslfControls({
        preset: "steady",
        set: {
          historyMessages: 120,
          cutOld: false,
          compaction: "oldest",
          blocks: ["skills", "handedOff"],
          noticeWakes: "all",
          nudges: { answer: false },
          autoMove: null,
          burstWait: 0,
          stretchRuns: 10,
          consultTtlMin: 1440,
          readMaxChars: 400_000,
        },
      }),
    ).toEqual({
      preset: "steady",
      set: {
        historyMessages: 120,
        cutOld: false,
        compaction: "oldest",
        blocks: ["skills", "handedOff"],
        noticeWakes: "all",
        nudges: { answer: false },
        autoMove: null,
        burstWait: 0,
        stretchRuns: 10,
        consultTtlMin: 1440,
        readMaxChars: 400_000,
      },
    });
  });

  test("unknown keys and an unknown preset are dropped", () => {
    expect(lslfControls({ preset: "calm", set: { louder: true, cutOld: false }, extra: 1 })).toEqual({
      set: { cutOld: false },
    });
    // Workspace-scope keys are env vars only: an agent can't set them.
    expect(lslfControls({ set: { reflect: false, summaries: false, vaultSync: false } })).toEqual({});
    // Not an own key of the table.
    expect(lslfControls({ set: { toString: false, constructor: 1, __proto__: { cutOld: false } } })).toEqual({});
  });

  test("bad values are refused, so the key follows the layer below", () => {
    const bad = lslfControls({
      set: {
        cutOld: "off",
        historyAnchor: 0,
        compaction: "smart",
        memory: "none",
        turnEnd: "quiet",
        historyMessages: 0,
        readMaxChars: 400_001,
        stretchRuns: 9,
        consultTtlMin: 1441,
        burstWait: 10_001,
        consultTtl: 60,
        blocks: "some",
        noticeWakes: 3,
        nudges: { answer: "no" },
      },
    });
    expect(bad).toEqual({});
    // Out of range is refused, never clamped to the edge.
    expect(lslfControls({ set: { stretchRuns: 500 } }).set?.stretchRuns).toBeUndefined();
    expect(lslfControls({ set: { historyMessages: 12.5 } }).set?.historyMessages).toBeUndefined();
    // A list keeps only known names, once each; empty is a choice (none).
    expect(lslfControls({ set: { blocks: ["skills", "skills", "everything", 4] } }).set?.blocks).toEqual(["skills"]);
    expect(lslfControls({ set: { noticeWakes: [] } }).set?.noticeWakes).toEqual([]);
  });

  test("safeguards cannot be set off: no key reaches them, and the secret check is not a nudge", () => {
    const off = Object.fromEntries(SAFEGUARDS.map((k) => [k, false]));
    expect(lslfControls({ set: off })).toEqual({});
    expect(lslfControls({ set: { nudges: { secret: false, secretCheck: false } } })).toEqual({});
    expect(lslfControls({ set: { nudges: { secret: false, ask: false } } })).toEqual({
      set: { nudges: { ask: false } },
    });
    for (const key of SAFEGUARDS) expect(LSLF_AGENT_KEYS as string[]).not.toContain(key);
    for (const key of SAFEGUARDS) expect(LSLF_WORKSPACE_KEYS as string[]).not.toContain(key);
    // Resolved, under either preset, with everything set off: still no safeguard key.
    for (const preset of ["stock", "steady"]) {
      const r = resolveAgentControls({ lslf: { preset, set: { ...off, nudges: { secret: false } } } }, ORG);
      for (const key of SAFEGUARDS) expect(Object.keys(r.controls)).not.toContain(key);
      expect(Object.keys(r.controls.nudges)).not.toContain("secret");
    }
    expect(Object.keys(resolveWorkspaceControls(ORG, server({ preset: "steady" })))).toEqual(LSLF_WORKSPACE_KEYS);
  });

  test("the presets are data with every key; steady's values are the plan's", () => {
    expect(Object.keys(STEADY_AGENT_CONTROLS).sort()).toEqual([...LSLF_AGENT_KEYS].sort());
    expect(Object.keys(STEADY_WORKSPACE_CONTROLS).sort()).toEqual([...LSLF_WORKSPACE_KEYS].sort());
    expect(LSLF_AGENT_KEYS).toHaveLength(45);
    // Each preset value passes the validator, so a preset can't hold what a person couldn't set.
    for (const preset of [STOCK_AGENT_CONTROLS, STEADY_AGENT_CONTROLS]) {
      expect(lslfControls({ set: preset }).set).toEqual(
        Object.fromEntries(Object.entries(preset).filter(([, v]) => v !== undefined)) as never,
      );
    }
    expect(STEADY_AGENT_CONTROLS).toMatchObject({
      historyMessages: 100,
      readMaxChars: 400_000,
      consultTtlMin: 60,
      compaction: "oldest",
      turnEnd: "plain",
      stuck: "off",
      autoMove: false,
      workTools: false,
      askWaits: true,
      stopJudge: true,
      liveSteer: true,
      stretchRuns: 50,
      blocks: ["handedOff", "waitingOnPerson", "skills"],
    });
    expect(STEADY_AGENT_CONTROLS.noticeWakes).toContain("work_follow_up");
    expect(STEADY_WORKSPACE_CONTROLS).toEqual({
      reflect: false,
      summaries: false,
      memoryUpkeep: false,
      memoryMerge: false,
      skillUpkeep: false,
      threadAssess: false,
      vaultSync: true,
    });
    // The presets can't be changed by whoever reads them.
    expect(Object.isFrozen(STOCK_AGENT_CONTROLS)).toBe(true);
    expect(Object.isFrozen(STEADY_AGENT_CONTROLS)).toBe(true);
  });
});

describe("resolution: agent set → agent preset → server preset → stock", () => {
  test("nothing anywhere: stock", () => {
    expect(resolveAgentControls({}, ORG)).toEqual({
      preset: "stock",
      presetFrom: "stock",
      set: [],
      controls: { ...STOCK_AGENT_CONTROLS },
    });
    expect(resolveWorkspaceControls(ORG)).toEqual({ ...STOCK_WORKSPACE_CONTROLS });
  });

  test("stock data from before controls existed (no lslf key) resolves to stock, even malformed", () => {
    for (const brakes of [
      { maxUnrequested: 3, callAgents: "some", callAgentIds: ["x"], wakeWords: ["invoice"] },
      null,
      undefined,
      "garbage",
      { lslf: "steady" },
      { lslf: null },
    ]) {
      const r = resolveAgentControls(brakes, ORG);
      expect(r.preset).toBe("stock");
      expect(r.controls).toEqual({ ...STOCK_AGENT_CONTROLS });
    }
  });

  test("the server's preset applies where nothing more specific is set", () => {
    const r = resolveAgentControls({}, ORG, server({ preset: "steady" }));
    expect(r).toMatchObject({ preset: "steady", presetFrom: "server", set: [] });
    expect(r.controls).toEqual({ ...STEADY_AGENT_CONTROLS });
  });

  test("LSLF_CONTROLS_ORGS limits the server's preset to the workspaces it names", () => {
    const only = server({ preset: "steady", orgs: [ORG] });
    expect(resolveAgentControls({}, ORG, only).preset).toBe("steady");
    expect(resolveAgentControls({}, OTHER_ORG, only)).toMatchObject({ preset: "stock", presetFrom: "stock" });
    // An agent's own choice applies wherever it is.
    expect(resolveAgentControls({ lslf: { preset: "steady" } }, OTHER_ORG, only).preset).toBe("steady");
  });

  test("the agent's preset wins over the server's, either way", () => {
    expect(resolveAgentControls({ lslf: { preset: "steady" } }, ORG)).toMatchObject({
      preset: "steady",
      presetFrom: "agent",
    });
    const stockAgent = resolveAgentControls({ lslf: { preset: "stock" } }, ORG, server({ preset: "steady" }));
    expect(stockAgent).toMatchObject({ preset: "stock", presetFrom: "agent" });
    expect(stockAgent.controls).toEqual({ ...STOCK_AGENT_CONTROLS });
  });

  test("the agent's set wins over its preset and the server's, key by key", () => {
    const overAgent = resolveAgentControls(
      { lslf: { preset: "steady", set: { historyMessages: 40, talker: true } } },
      ORG,
    );
    expect(overAgent.set.sort()).toEqual(["historyMessages", "talker"]);
    expect(overAgent.controls).toEqual({ ...STEADY_AGENT_CONTROLS, historyMessages: 40, talker: true });

    const overServer = resolveAgentControls({ lslf: { set: { cutOld: true } } }, ORG, server({ preset: "steady" }));
    expect(overServer.presetFrom).toBe("server");
    expect(overServer.controls).toEqual({ ...STEADY_AGENT_CONTROLS, cutOld: true });

    const overStock = resolveAgentControls({ lslf: { set: { learn: false } } }, ORG);
    expect(overStock.controls).toEqual({ ...STOCK_AGENT_CONTROLS, learn: false });
  });

  test("nudges merge kind by kind over the preset", () => {
    const r = resolveAgentControls({ lslf: { set: { nudges: { untried: false } } } }, ORG);
    expect(r.controls.nudges).toEqual({ ...STOCK_AGENT_CONTROLS.nudges, untried: false });
    expect(Object.values(r.controls.nudges).filter((on) => !on)).toHaveLength(1);
  });

  test("a resolved list is a copy: changing it never changes the preset", () => {
    const r = resolveAgentControls({ lslf: { preset: "steady" } }, ORG);
    (r.controls.blocks as string[]).push("recentActions");
    r.controls.nudges.answer = false;
    expect(STEADY_AGENT_CONTROLS.blocks).toEqual(["handedOff", "waitingOnPerson", "skills"]);
    expect(STEADY_AGENT_CONTROLS.nudges.answer).toBe(true);
  });

  test("workspace controls: LSLF_WORKSPACE_SET → server preset → stock, only in the listed workspaces", () => {
    expect(resolveWorkspaceControls(ORG, server({ preset: "steady" }))).toEqual({ ...STEADY_WORKSPACE_CONTROLS });
    expect(resolveWorkspaceControls(ORG, server({ workspaceSet: { reflect: false } }))).toEqual({
      ...STOCK_WORKSPACE_CONTROLS,
      reflect: false,
    });
    expect(resolveWorkspaceControls(ORG, server({ preset: "steady", workspaceSet: { summaries: true } }))).toEqual({
      ...STEADY_WORKSPACE_CONTROLS,
      summaries: true,
    });
    const only = server({ preset: "steady", orgs: [ORG], workspaceSet: { vaultSync: false } });
    expect(resolveWorkspaceControls(ORG, only)).toEqual({ ...STEADY_WORKSPACE_CONTROLS, vaultSync: false });
    expect(resolveWorkspaceControls(OTHER_ORG, only)).toEqual({ ...STOCK_WORKSPACE_CONTROLS });
  });

  test("the env values read: unknown workspace keys and values ignored, empty lists mean every workspace", () => {
    expect(parseWorkspaceSet("reflect=off, summaries = ON,threadAssess=false,vaultSync=true")).toEqual({
      reflect: false,
      summaries: true,
      threadAssess: false,
      vaultSync: true,
    });
    expect(parseWorkspaceSet("cutOld=off,approvals=off,reflect=maybe,=on,reflect")).toEqual({});
    expect(parseWorkspaceSet(undefined)).toEqual({});
    expect(lslfServerSettings({})).toEqual({ preset: "stock", orgs: null, workspaceSet: {} });
    expect(lslfServerSettings({ preset: "steady", orgs: [" ", ""], workspaceSet: "reflect=off" })).toEqual({
      preset: "steady",
      orgs: null,
      workspaceSet: { reflect: false },
    });
    expect(lslfServerSettings({ preset: "calm", orgs: [ORG] })).toMatchObject({ preset: "stock", orgs: [ORG] });
  });
});

describe("the brakes save keeps the controls", () => {
  test("chosenAutonomy keeps lslf normalized and drops an empty one; stock autonomySettings ignores it", () => {
    expect(chosenAutonomy({ costly: "ask", lslf: { preset: "steady", set: { cutOld: false, junk: 1 } } })).toEqual({
      costly: "ask",
      lslf: { preset: "steady", set: { cutOld: false } },
    });
    expect(chosenAutonomy({ costly: "ask", lslf: { set: { junk: 1 } } })).toEqual({ costly: "ask" });
    expect(chosenAutonomy({ costly: "ask", lslf: null })).toEqual({ costly: "ask" });
    // Switching back to the official image: the settings it knows read the same, the lslf key is never read.
    const brakes = { maxUnrequested: 4, wakeAgents: "always" };
    expect(autonomySettings({ ...brakes, lslf: { preset: "steady" } })).toEqual(autonomySettings(brakes));
  });

  test("a later brakes save keeps lslf; replacing it or clearing it works", async () => {
    f = await setup();
    const fx = f;
    const save = (autonomyBrakes: Record<string, unknown>) =>
      updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { autonomyBrakes });

    const first = await save({ lslf: { preset: "steady", set: { historyMessages: 60, bogus: true } } });
    expect(first.autonomyBrakes).toEqual({ lslf: { preset: "steady", set: { historyMessages: 60 } } });

    // The Autonomia card saves only its own fields: the controls stay.
    const later = await save({ maxUnrequested: 5, wakeAgents: "always" });
    expect(later.autonomyBrakes).toEqual({
      maxUnrequested: 5,
      wakeAgents: "always",
      lslf: { preset: "steady", set: { historyMessages: 60 } },
    });
    expect((await getAgent(fx.db, fx.org.id, fx.agent.id))?.autonomyBrakes?.lslf).toEqual({
      preset: "steady",
      set: { historyMessages: 60 },
    });

    const replaced = await save({ lslf: { set: { cutOld: false } } });
    expect(replaced.autonomyBrakes).toEqual({
      maxUnrequested: 5,
      wakeAgents: "always",
      lslf: { set: { cutOld: false } },
    });

    const cleared = await save({ lslf: null });
    expect(cleared.autonomyBrakes).toEqual({ maxUnrequested: 5, wakeAgents: "always" });
  });
});

/** The `context` steps of every run, in order. */
const contextSteps = (fx: Fixture) =>
  fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.kind, "context"))
    .orderBy(asc(schema.agentRunSteps.seq));

describe("a run resolves its controls once", () => {
  test("its first context step records the resolved controls and where they came from", async () => {
    f = await setup({ reply: () => ({ chunks: ["Pronto."] }), lslf: server({ preset: "steady" }) });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, {
      autonomyBrakes: { lslf: { set: { historyMessages: 70 } } },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);

    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    const steps = await contextSteps(f);
    const recorded = steps.filter((s) => s.data[RUN_CONTROLS_STEP_KEY]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.seq).toBe(steps[0]?.seq);
    expect(recorded[0]?.data[RUN_CONTROLS_STEP_KEY]).toEqual({
      preset: "steady",
      presetFrom: "server",
      set: ["historyMessages"],
      controls: { ...STEADY_AGENT_CONTROLS, historyMessages: 70 },
    });
    expect(await runControls(f.db, { id: run?.id ?? "", orgId: f.org.id })).toEqual(
      recorded[0]?.data[RUN_CONTROLS_STEP_KEY] as never,
    );
  });

  test("an agent with nothing set records stock", async () => {
    f = await setup({ reply: () => ({ chunks: ["Pronto."] }) });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(await runControls(f.db, { id: run?.id ?? "", orgId: f.org.id })).toEqual({
      preset: "stock",
      presetFrom: "stock",
      set: [],
      controls: { ...STOCK_AGENT_CONTROLS },
    });
  });

  test("a change made while the run waits doesn't change the run in flight; the next run takes it", async () => {
    f = await setup({
      askUser: true,
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        return {
          chunks: [],
          toolUses: [
            {
              name: "ask_user",
              input: {
                why: "I need a person's answer before I go on: this decides what I change next.",
                question: "Qual ambiente?",
                choices: ["staging", "production"],
              },
            },
          ],
        };
      },
    });
    const fx = f;
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { autonomyBrakes: { lslf: { preset: "steady" } } });
    await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "@dev faz o deploy",
    });
    await drainOutbox(fx.db, fx.handlers);
    const [run] = await fx.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("waiting_input");
    const ref = { id: run?.id ?? "", orgId: fx.org.id };
    expect((await runControls(fx.db, ref))?.preset).toBe("steady");

    // Mid-run, the agent goes back to stock with a key set.
    await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, {
      autonomyBrakes: { lslf: { preset: "stock", set: { learn: false } } },
    });
    const [q] = await fx.db.select().from(schema.agentQuestions);
    await answerQuestion({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, q?.id ?? "", { choice: "staging" });
    await drainOutbox(fx.db, fx.handlers);

    const [resumed] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, ref.id));
    expect(resumed?.status).toBe("done");
    const mine = (await contextSteps(fx)).filter((s) => s.runId === ref.id && s.data[RUN_CONTROLS_STEP_KEY]);
    expect(mine).toHaveLength(1);
    expect(await runControls(fx.db, ref)).toEqual({
      preset: "steady",
      presetFrom: "agent",
      set: [],
      controls: { ...STEADY_AGENT_CONTROLS },
    });

    // A new run resolves again and takes the change.
    await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "@dev obrigado",
    });
    await drainOutbox(fx.db, fx.handlers);
    const next = (await fx.db.select().from(schema.agentRuns)).find((r) => r.id !== ref.id);
    expect(await runControls(fx.db, { id: next?.id ?? "", orgId: fx.org.id })).toMatchObject({
      preset: "stock",
      presetFrom: "agent",
      set: ["learn"],
      controls: { ...STOCK_AGENT_CONTROLS, learn: false },
    });
  });

  test("a run that recorded nothing (started before controls existed) reads null", async () => {
    f = await setup();
    expect(await runControls(f.db, { id: "00000000-0000-0000-0000-0000000000ff", orgId: f.org.id })).toBeNull();
  });
});

/** A step's data with the ids each database makes (rows, messages, usage) written as `<id>`. */
const withoutIds = (data: unknown) =>
  JSON.parse(JSON.stringify(data).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"));

describe("no behaviour reads a control yet", () => {
  /** One conversation, start to end: what the model received, what was posted, which steps and jobs there were. */
  async function conversation(lslf: LslfServerSettings | undefined, brakes?: Record<string, unknown>) {
    const fx = await setup({ askUser: true, reply: () => ({ chunks: ["Vou ver o build."] }), lslf });
    try {
      if (brakes) await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { autonomyBrakes: brakes });
      for (const body of ["@dev o build quebrou", "@dev e agora?", "obrigado!"]) {
        await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });
        await drainOutbox(fx.db, fx.handlers);
      }
      const runs = await fx.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
      const steps = await fx.db.select().from(schema.agentRunSteps).orderBy(asc(schema.agentRunSteps.seq));
      const posted = await fx.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt));
      const jobs = await fx.db.select().from(schema.outbox);
      return {
        requests: fx.provider.calls.map((c) => ({
          model: c.request.model,
          system: systemText(c.request.system ?? ""),
          messages: c.request.messages,
          tools: (c.request.tools ?? []).map((t) => t.name),
        })),
        runs: runs.map((r) => [r.status, r.hop]),
        steps: runs.map((r) =>
          steps
            .filter((s) => s.runId === r.id)
            .map((s) => {
              // Everything a step says but the controls it recorded, and the per-run memory arm.
              const { [RUN_CONTROLS_STEP_KEY]: _controls, memoryArm: _arm, ...rest } = s.data;
              return [s.kind, withoutIds(rest)];
            }),
        ),
        posted: posted.map((m) => [m.authorType, m.body, m.threadId === null]),
        jobs: jobs.map((j) => [j.kind, j.status]).sort(),
      };
    } finally {
      await fx.close();
    }
  }

  test("steady on the server and on the agent: the same prompts, replies, steps and jobs as stock", async () => {
    const stock = await conversation(undefined);
    const steady = await conversation(
      server({ preset: "steady", workspaceSet: { reflect: false, summaries: false } }),
      { lslf: { preset: "steady", set: { historyMessages: 5, turnEnd: "plain", workTools: false } } },
    );
    expect(stock.requests.length).toBeGreaterThan(0);
    expect(steady.requests).toEqual(stock.requests);
    expect(steady.runs).toEqual(stock.runs);
    expect(steady.steps).toEqual(stock.steps);
    expect(steady.posted).toEqual(stock.posted);
    expect(steady.jobs).toEqual(stock.jobs);
  });
});
