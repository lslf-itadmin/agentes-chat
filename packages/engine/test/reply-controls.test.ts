import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { type ModelRequest, textOf } from "@agenteschat/providers";
import { AUTONOMY_DEFAULTS, autonomySettings, drainOutbox, getAgent, postPersonMessage, updateAgent } from "../src";
import { decideTurnEnd, FOLLOW_THROUGH_OFF, type TurnEnd } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * Per-agent switches over Agentes' own interventions in an agent's replies, stored with its autonomy brakes: the
 * follow-through judge. Untouched, every one is today's behaviour.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const judgeCalls = (fx: Fixture, kind: string) =>
  (fx.context.judge as unknown as { calls: { kind: string }[] }).calls.filter((c) => c.kind === kind);

const agentMessages = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice,
  );

const ask = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const setBrakes = (fx: Fixture, brakes: Record<string, unknown>) =>
  updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { autonomyBrakes: brakes });

describe("the settings", () => {
  test("untouched, the follow-through judge is on; only a stored false turns it off", () => {
    expect(autonomySettings({}).followThrough).toBe(true);
    expect(AUTONOMY_DEFAULTS.followThrough).toBe(true);
    expect(autonomySettings({ followThrough: "no" }).followThrough).toBe(true);
    expect(autonomySettings({ followThrough: false }).followThrough).toBe(false);
  });

  test("saved through updateAgent next to the wake controls, only the fields given", async () => {
    f = await setup();
    await setBrakes(f, { wakeRouter: false });
    await setBrakes(f, { followThrough: false });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.autonomyBrakes).toEqual({
      wakeRouter: false,
      followThrough: false,
    });
  });
});

describe("the follow-through judge", () => {
  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "I'll check again later and send the numbers.",
    mission: false,
    wakesLater: async () => false,
    verdict: async () => "continue",
    ...over,
  });

  test("off: no judgment, no nudge of any kind, the turn ends with its reply", async () => {
    let asked = 0;
    const verdict = async () => {
      asked++;
      return "continue" as const;
    };
    const off = { followThrough: false, verdict };
    expect(await decideTurnEnd(turn(off))).toEqual({ outcome: "done", rule: FOLLOW_THROUGH_OFF });
    // The controller's other extra turns stay off too: a decision's result, an empty answer, a request still open,
    // a widget's data, a reply naming its tools or citing files on its computer.
    for (const over of [
      { decided: "approved: merged" },
      { unanswered: true },
      { openRequest: "say whether you still need it" },
      { widgetOwed: true },
      { namedTools: ["post_message"] },
      { localPaths: ["/home/agent/report.md"] },
    ])
      expect((await decideTurnEnd(turn({ ...off, ...over }))).outcome).toBe("done");
    expect(asked).toBe(0);
    // A quiet turn stays quiet (nothing posted), and a bound still says why it ended.
    expect((await decideTurnEnd(turn({ ...off, quiet: true }))).rule).toBe("quiet");
    expect((await decideTurnEnd(turn({ ...off, bound: "stuck" }))).rule).toBe("stuck");
  });

  test("untouched: today's controller (the judge reads the reply and a promise gets its nudge)", async () => {
    let asked = 0;
    const d = await decideTurnEnd(
      turn({
        verdict: async () => {
          asked++;
          return "continue";
        },
      }),
    );
    expect(asked).toBe(1);
    expect(d).toMatchObject({ outcome: "continue", rule: "promise" });
    expect((await decideTurnEnd(turn({ followThrough: true }))).rule).toBe("promise");
  });

  test("off in a run: the promise is posted as written, once, with no judge call and no extra turn", async () => {
    const promised = "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números.";
    f = await setup({
      judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
      reply: () => ({ chunks: [promised] }),
    });
    await setBrakes(f, { followThrough: false });
    await ask(f, "@dev o ci demora tanto assim?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    expect(judgeCalls(f, "follow_through")).toEqual([]);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([promised]);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(run?.threadRootId).toBe(run?.triggerMessageId);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === FOLLOW_THROUGH_OFF)).toBe(
      true,
    );
    expect(steps.some((s) => s.data.nudged)).toBe(false);
  });

  test("on (untouched) in the same run: the judge is asked and the promise gets one more turn", async () => {
    f = await setup({
      judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
      reply: (_request, call) => ({
        chunks: [call === 1 ? "Vou checar de novo e te passo os números." : "Pronto: 12 min."],
      }),
    });
    await ask(f, "@dev o ci demora tanto assim?");
    await drainOutbox(f.db, f.handlers);
    expect(judgeCalls(f, "follow_through").length).toBeGreaterThan(0);
    expect(f.provider.calls.length).toBeGreaterThan(1);
    expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toContain("You ended saying you would do more");
  });
});
