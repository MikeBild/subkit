import { describe, expect } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import type { WorkflowTrigger } from "../../workflows/types.ts";
import { runAuthoringPipeline } from "../authoring-pipeline.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import type { RecordedEvalReport } from "../recorded-eval.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import {
  fetchCalls,
  makeCtx,
  tw,
  useAuthoringPipelineSetup,
  VALID_DEF,
} from "./authoring-pipeline-fixtures.ts";

useAuthoringPipelineSetup();

describe("author_workflow — tool envelope", () => {
  tw(
    "returns the evaluated draft payload with recorded_eval + next_step and stashes the goal",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      const result = await authorWorkflowTool.execute(toolCtx, {
        goal: "Show me the top repos with their names",
      });
      expect(result.ok).toBe(true);
      const data = result.data as {
        recorded_eval: RecordedEvalReport;
        next_step: string;
        attempts: number;
        definition: { slug: string };
        persistence: string;
      };
      expect(data.next_step).toBe("dry_run_workflow");
      expect(data.attempts).toBe(1);
      expect(data.definition.slug).toBe("top-repos-digest");
      expect(data.persistence).toBe("draft_only");
      expect(data.recorded_eval).toBeDefined();
      expect((toolCtx._draft.value!.workflow as { goal?: string }).goal).toBe(
        "Show me the top repos with their names",
      );
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "explicit identity is retained before preview even when generation chooses another name",
    async () => {
      getMockProvider().generateOverrides.generate = () => structuredClone(VALID_DEF);
      const toolCtx = makeCtx();
      const result = await authorWorkflowTool.execute(toolCtx, {
        goal: "Prepare the requested workflow",
        name: "Requested report",
        slug: "requested-report",
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        definition: { name: "Requested report", slug: "requested-report" },
        workflow: { name: "Requested report", slug: "requested-report" },
        persistence: "draft_only",
      });
      expect(toolCtx.getDraft().workflow).toMatchObject({
        name: "Requested report",
        slug: "requested-report",
      });
      expect(fetchCalls).toBe(0);
    },
  );

  tw("generation failure surfaces as a typed envelope, not a throw", async () => {
    getMockProvider().generateOverrides.generate = () => ({ nope: true });
    const toolCtx = makeCtx();
    const result = await authorWorkflowTool.execute(toolCtx, { goal: "impossible" });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string };
    expect(data.error_code).toBe("authoring_generation_failed");
  });
});

describe("runAuthoringPipeline — trigger preservation on edit (webhook-binding safety)", () => {
  const WEBHOOK_TRIGGER: WorkflowTrigger = {
    kind: "webhook",
    source: "stripe",
    events: [],
    verify: "stripe-signature",
  };

  function seedWebhookEditDraft(toolCtx: ReturnType<typeof makeCtx>, slug: string) {
    const seeded = createEmptyDraftDocument("workflow_authoring");
    seeded.workflow = {
      name: "Top repos digest",
      slug,
      steps: [],
      trigger: { ...WEBHOOK_TRIGGER },
    };
    return toolCtx.setDraft(seeded);
  }

  tw(
    "preserves an existing webhook trigger when the regenerated draft (same slug) omits it",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      await seedWebhookEditDraft(toolCtx, "top-repos-digest");

      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "tweak the digest step" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.definition.trigger).toEqual({ ...WEBHOOK_TRIGGER });
      expect(toolCtx._draft.value?.workflow.trigger).toEqual({ ...WEBHOOK_TRIGGER });
      expect(fetchCalls).toBe(0);
    },
  );

  tw("respects an explicitly regenerated trigger (schedule) over the saved webhook", async () => {
    const SCHEDULED = {
      ...VALID_DEF,
      trigger: { kind: "schedule", cron: "0 9 * * *", tz: "Europe/Berlin" },
    };
    getMockProvider().generateOverrides.generate = () => SCHEDULED;
    const toolCtx = makeCtx();
    await seedWebhookEditDraft(toolCtx, "top-repos-digest");

    const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "make it run daily at 9am" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.definition.trigger?.kind).toBe("schedule");
    expect(toolCtx._draft.value?.workflow.trigger?.kind).toBe("schedule");
    expect(fetchCalls).toBe(0);
  });

  tw(
    "does NOT preserve on a full replace (regenerated slug differs from the saved workflow)",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      await seedWebhookEditDraft(toolCtx, "some-other-workflow");

      const result = await runAuthoringPipeline({
        ctx: toolCtx,
        goal: "a totally different workflow",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.definition.trigger).toBeUndefined();
      expect(toolCtx._draft.value?.workflow.trigger).toBeUndefined();
      expect(fetchCalls).toBe(0);
    },
  );
});

describe("runAuthoringPipeline — consistency warnings", () => {
  tw("stashes the draft and reports a schedule without tz as a warning with rule_id", async () => {
    getMockProvider().generateOverrides.generate = () => ({
      ...VALID_DEF,
      trigger: { kind: "schedule", cron: "0 9 * * *" },
    });
    const toolCtx = makeCtx();
    const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "run the digest daily" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.validation.warnings.map((w) => [w.path, w.rule_id])).toEqual([
      ["trigger.tz", "consistency.schedule_tz"],
    ]);
    expect(toolCtx._draft.value?.workflow.trigger?.kind).toBe("schedule");
    expect(fetchCalls).toBe(0);
  });
});

describe("runAuthoringPipeline — semantic critic wire-in", () => {
  const DRIFT_FIXED_DEF = {
    ...VALID_DEF,
    name: "Top repos digest (repaired)",
    slug: "top-repos-digest-repaired",
  };

  tw(
    "default-off: a static-clean draft is returned unchanged and the critic never runs",
    async () => {
      await setConfigKey(["llm", "critic", "enabled"], false);
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "top repos please" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.attempts).toBe(1);
      expect(result.definition.slug).toBe("top-repos-digest");
      expect(result.critic_rejection).toBeUndefined();
      expect(result.critic).toMatchObject({ result: "skipped_disabled", returned_pass: 1 });
      expect(getMockProvider().calls.filter((c) => c.flow === "critic_authoring")).toHaveLength(0);
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "enabled: a green-static but semantically-drifted draft is caught by the critic and repaired via one more grounded pass",
    async () => {
      try {
        await setConfigKey(["llm", "critic", "enabled"], true);
        await setConfigKey(["llm", "critic", "min_steps"], 2);

        let genCalls = 0;
        getMockProvider().generateOverrides.generate = () => {
          genCalls += 1;
          return genCalls === 1 ? VALID_DEF : DRIFT_FIXED_DEF;
        };
        getMockProvider().generateOverrides.critic_authoring = () => ({
          passed: false,
          repairs: ["Reorder shape_repos before fetch_repos consumes it"],
          rationale: "step order drift",
        });

        const toolCtx = makeCtx();
        const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "top repos with names" });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");

        expect(getMockProvider().calls.filter((c) => c.flow === "critic_authoring")).toHaveLength(
          1,
        );
        expect(genCalls).toBe(2);
        expect(result.attempts).toBe(2);
        expect(result.definition.slug).toBe("top-repos-digest-repaired");
        expect(result.critic_rejection).toBeDefined();
        expect(result.critic_rejection?.repairs[0]).toContain("Reorder shape_repos");
        expect(result.critic_rejection?.gating_reason).toBe("step_count");
        expect(result.critic).toEqual({
          result: "reject",
          gating_reason: "step_count",
          reviewed_pass: 1,
          returned_pass: 2,
          reviewed_returned_definition: false,
        });
        expect(result.candidate_swap).toBeUndefined();
        const criticCall = getMockProvider().calls.find((c) => c.flow === "critic_authoring");
        expect(criticCall?.last_user).toContain("top repos with names");
        const genPrompts = getMockProvider().calls.filter((c) => c.flow === "generate");
        expect(genPrompts).toHaveLength(2);
        expect(genPrompts[1]?.last_user).toContain("Findings from the previous attempt");
        expect(genPrompts[1]?.last_user).toContain("Reorder shape_repos");
        expect(fetchCalls).toBe(0);
      } finally {
        await setConfigKey(["llm", "critic", "enabled"], false);
        await setConfigKey(["llm", "critic", "min_steps"], 3);
      }
    },
  );

  tw(
    "author_workflow surfaces the critic_rejection advisory on its SUCCESSFUL result (feeds the next-turn signal)",
    async () => {
      try {
        await setConfigKey(["llm", "critic", "enabled"], true);
        await setConfigKey(["llm", "critic", "min_steps"], 2);
        getMockProvider().generateOverrides.generate = () => VALID_DEF;
        getMockProvider().generateOverrides.critic_authoring = () => ({
          passed: false,
          repairs: ["Add an idempotency_key to the POST step"],
          rationale: "missing idempotency",
        });
        const toolCtx = makeCtx();
        const result = await authorWorkflowTool.execute(toolCtx, { goal: "repos digest" });
        expect(result.ok).toBe(true);
        const data = result.data as {
          persistence: string;
          critic_rejection?: { repairs: string[]; rationale: string; gating_reason: string };
        };
        expect(data.persistence).toBe("draft_only");
        expect(data.critic_rejection).toBeDefined();
        expect(data.critic_rejection?.repairs[0]).toContain("idempotency_key");
        expect((data as { critic?: { result: string } }).critic?.result).toBe("reject");
        expect((data as { error_code?: string }).error_code).toBeUndefined();
        expect(fetchCalls).toBe(0);
      } finally {
        await setConfigKey(["llm", "critic", "enabled"], false);
        await setConfigKey(["llm", "critic", "min_steps"], 3);
      }
    },
  );
});
