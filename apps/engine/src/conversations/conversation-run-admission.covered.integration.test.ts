import { describe, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { recordConfirmationSkipped } from "./confirmation.ts";
import {
  ASK_FIRST,
  ASK_HELD,
  ASK_UNCOVERED,
  authorityOf,
  type Fixture,
  type Observed,
  observe,
  type Path,
  RUN_HELD,
  RUN_LIVE,
  type Started,
  skipAudits,
  start,
  startFast,
  startGeneric,
  startSynthetic,
  toolCalls,
} from "./conversation-run-admission-covered-fixtures.ts";
import {
  fixture,
  tdb,
  useConversationRunAdmissionSetup,
} from "./conversation-run-admission-fixtures.ts";

const nextUuid = createDeterministicUuidFactory(0x7a5c02);

useConversationRunAdmissionSetup();

type Expected = { covered: Observed; uncovered: Observed };

const TABLE: Record<Path, readonly [boolean, Expected][]> = {
  generic: [
    [false, { covered: RUN_LIVE, uncovered: RUN_HELD }],
    [true, { covered: RUN_LIVE, uncovered: ASK_UNCOVERED.generic }],
  ],
  synthetic: [
    [false, { covered: RUN_LIVE, uncovered: ASK_HELD }],
    [true, { covered: RUN_LIVE, uncovered: ASK_UNCOVERED.synthetic }],
  ],
  fast: [
    [false, { covered: RUN_LIVE, uncovered: RUN_HELD }],
    [true, { covered: RUN_LIVE, uncovered: ASK_UNCOVERED.fast }],
  ],
};

describe("start path × ask before writing × covered", () => {
  for (const path of Object.keys(TABLE) as Path[]) {
    for (const [ask, expected] of TABLE[path]) {
      test(`${path} with ask_before_writing=${ask} and a covering authority`, async () => {
        const f = await fixture({ maxRuns: 2 });
        expect(await observe(f, start(path, f, ask))).toEqual(expected.covered);
        expect(await f.reserved()).toBe(expected.covered.writes === "live" ? 1 : 0);
      });

      test(`${path} with ask_before_writing=${ask} without an authority`, async () => {
        const f = await fixture();
        expect(await observe(f, start(path, f, ask))).toEqual(expected.uncovered);
      });
    }
  }
});

describe("special cases keep asking before writing although an authority covers the run", () => {
  const CONFIRM = "confirm_before_execution";

  const cases: [string, (f: Fixture) => Promise<Started>, Observed][] = [
    [
      "generic: a confirm override for run_workflow",
      (f) => startGeneric(f, true, { run_workflow: CONFIRM }),
      ASK_FIRST,
    ],
    [
      "generic: a confirm override for the workflow's own tool",
      (f) => startGeneric(f, true, { [`wf_${f.workflow.slug}`]: CONFIRM }),
      ASK_FIRST,
    ],
    [
      "generic: an explicit preparation is not a covered run",
      (f) => startGeneric(f, true, {}, { execute_writes: false }),
      ASK_FIRST,
    ],
    [
      "generic: a prepared version that is no longer active",
      (f) => startGeneric(f, true, {}, { expected_workflow_version_id: nextUuid() }),
      ASK_FIRST,
    ],
    [
      "synthetic: a confirm override for the workflow's own tool",
      (f) => startSynthetic(f, true, { [`wf_${f.workflow.slug}`]: CONFIRM }),
      ASK_HELD,
    ],
    [
      "synthetic: a confirm override for run_workflow",
      (f) => startSynthetic(f, true, { run_workflow: CONFIRM }),
      ASK_HELD,
    ],
    [
      "fast path: a confirm override for run_workflow",
      (f) => startFast(f, true, { run_workflow: CONFIRM }),
      ASK_FIRST,
    ],
    [
      "fast path: a confirm override for the workflow's own tool",
      (f) => startFast(f, true, { [`wf_${f.workflow.slug}`]: CONFIRM }),
      ASK_FIRST,
    ],
  ];

  for (const [name, begin, expected] of cases) {
    test(name, async () => {
      const f = await fixture({ maxRuns: 2 });
      expect(await observe(f, () => begin(f))).toEqual(expected);
      expect(await f.reserved()).toBe(0);
      expect(await skipAudits(f)).toHaveLength(0);
    });
  }

  test("a confirm override for another workflow's tool does not reach this one", async () => {
    const generic = await fixture({ maxRuns: 2 });
    expect(
      await observe(generic, () => startGeneric(generic, true, { "wf_some-other": CONFIRM })),
    ).toEqual(RUN_LIVE);
    const fast = await fixture({ maxRuns: 2 });
    expect(await observe(fast, () => startFast(fast, true, { "wf_some-other": CONFIRM }))).toEqual(
      RUN_LIVE,
    );
  });

  for (const path of ["generic", "synthetic", "fast"] as const) {
    test(`${path}: an expired authority covers nothing`, async () => {
      const f = await fixture({ maxRuns: 2, expired: true });
      expect(await observe(f, start(path, f, true))).toEqual(ASK_UNCOVERED[path]);
      expect(await f.reserved()).toBe(0);
    });

    test(`${path}: an authority for the other environment covers nothing`, async () => {
      const f = await fixture({ maxRuns: 2, environment: "prod" });
      expect(await observe(f, start(path, f, true))).toEqual(ASK_UNCOVERED[path]);
      expect(await f.reserved()).toBe(0);
    });
  }
});

describe("a repeated start under the same idempotency key", () => {
  test("generic: the replay starts nothing and records no second skip", async () => {
    const f = await fixture({ maxRuns: 3 });
    const args = { idempotency_key: "covered-replay" };
    const first = await startGeneric(f, true, {}, args);
    expect(first.asked).toBe(false);
    expect(await skipAudits(f)).toHaveLength(1);
    const replay = await startGeneric(f, true, {}, args);
    expect(replay.asked).toBe(false);
    expect(replay.data).toMatchObject({ idempotent_replay: true });
    expect(await f.rows()).toHaveLength(1);
    expect(await f.reserved()).toBe(1);
    expect(await skipAudits(f)).toHaveLength(1);
    const marked = (await toolCalls(f)).filter(
      (call) =>
        (call.confirmation_data as { resolver_reason?: string } | null)?.resolver_reason ===
        "authority_covered",
    );
    expect(marked).toHaveLength(1);
  });

  test("the record is written once per tool call", async () => {
    const f = await fixture({ maxRuns: 2 });
    const started = await startGeneric(f, true);
    const [call] = await toolCalls(f);
    if (!call) throw new Error("missing tool call");
    await recordConfirmationSkipped({
      db: tdb.db,
      tenant_id: f.tenant.id,
      conversation_id: started.conversation_id,
      tool_call_id: call.id,
      tool: "run_workflow",
      environment: "dev",
      covering_authority_id: authorityOf(f).id,
      actor_id: null,
      actor_type: "system",
    });
    expect(await skipAudits(f)).toHaveLength(1);
    const [after] = await toolCalls(f);
    expect(after?.interaction_log).toHaveLength((call.interaction_log as unknown[]).length);
  });
});

describe("the skipped question is recorded the same way on every path", () => {
  const tools: Record<Path, (f: Fixture) => string> = {
    generic: () => "run_workflow",
    synthetic: (f) => `wf_${f.workflow.slug}`,
    fast: () => "run_workflow",
  };

  for (const path of ["generic", "synthetic", "fast"] as const) {
    test(`${path}: one audit row and the tool call name the covering authority`, async () => {
      const f = await fixture({ maxRuns: 2 });
      const started = await start(path, f, true)();
      expect(started.asked).toBe(false);
      const metadata = {
        tool: tools[path](f),
        conversation_id: started.conversation_id,
        environment: "dev",
        resolver_reason: "authority_covered",
        covering_authority_id: authorityOf(f).id,
      };
      const audits = await skipAudits(f);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        resource_type: "conversation",
        resource_id: started.conversation_id,
        result: "success",
        reason: "authority_covered",
      });
      expect(audits[0]?.metadata).toEqual(metadata);
      const [call] = await toolCalls(f);
      expect(call?.tool).toBe(metadata.tool);
      expect(call?.confirmation_data).toMatchObject(metadata);
      expect((await f.rows())[0]?.execution_authority_id).toBe(authorityOf(f).id);
    });

    test(`${path}: a run that needed no skip records none`, async () => {
      const f = await fixture({ maxRuns: 2 });
      expect(await observe(f, start(path, f, false))).toEqual(RUN_LIVE);
      expect(await skipAudits(f)).toHaveLength(0);
      expect(JSON.stringify((await toolCalls(f))[0]?.confirmation_data ?? {})).not.toContain(
        "covering_authority_id",
      );
    });
  }
});
