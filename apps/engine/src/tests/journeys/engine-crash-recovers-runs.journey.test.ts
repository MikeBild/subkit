import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, executionSteps, executions, llmUsage, users } from "../../db/schema/index.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import { createDeterministicHexFactory, waitFor } from "../../test-helpers/determinism/index.ts";
import {
  healthy,
  PROCESS_TEST_TIMEOUT_MS,
  processFixture,
} from "../../test-helpers/engine-process.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { journeyInvariantViolations } from "./invariants.ts";

const hex = createDeterministicHexFactory(0xc4a5);
const MODEL = "gpt-4.1-mini";

interface ScriptedModel {
  url: string;
  calls: () => number;
  held: () => boolean;
  stop: () => void;
}

function scriptedModel(): ScriptedModel {
  let calls = 0;
  let held = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      calls++;
      if (calls === 1)
        return Response.json({
          id: "resp_scripted",
          model: MODEL,
          output_text: "Draft the invoice for ACME.",
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
        });
      held = true;
      return new Promise<Response>(() => {});
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls: () => calls,
    held: () => held,
    stop: () => server.stop(true),
  };
}

async function seedOperator(db: Awaited<ReturnType<typeof processFixture>>["db"]["db"]) {
  const roles = await seedBuiltinRolesAndPermissions(db);
  const tenant = await seedTenant(db, { slug: "crash-journey", display_name: "Crash journey" });
  const [user] = await db
    .insert(users)
    .values({ tenant_id: tenant.id, email: "crash@test.local", role_id: roles.admin })
    .returning();
  if (!user) throw new Error("seed user failed");
  const plaintext = `wf_live_${hex(16)}`;
  await db.insert(apiKeys).values({
    tenant_id: tenant.id,
    user_id: user.id,
    prefix: plaintext.slice(0, 12),
    token_sha256: createHash("sha256").update(plaintext).digest("hex"),
    scopes: ["*"],
  });
  return { tenantId: tenant.id, apiKey: plaintext };
}

function modelStep(id: string, model: ScriptedModel, input: string) {
  return {
    id,
    kind: "request",
    method: "GET",
    url: `${model.url}/v1/responses?model=${MODEL}&input=${encodeURIComponent(input)}`,
  };
}

test(
  "an engine killed during a model turn comes back, recovers the run and leaves no broken state",
  async () => {
    const model = scriptedModel();
    const fixture = await processFixture("crash-journey", {
      config: {
        queue: { crash_recovery_threshold_ms: 1 },
        egress: { provider_hosts_extra: ["127.0.0.1"] },
        llm: {
          provider: "openai",
          model: MODEL,
          providers: { openai: { api_key: `subkit-scripted-${hex(16)}`, base_url: model.url } },
        },
      },
    });
    try {
      const { tenantId, apiKey } = await seedOperator(fixture.db.db);
      const first = fixture.start(fixture.key, "crash-journey-first");
      await healthy(fixture, first);

      const run = fetch(`http://127.0.0.1:${fixture.port}/v1/executions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          source: "draft",
          definition: {
            name: "Crash model turn",
            slug: "crash-model-turn",
            steps: [
              modelStep("plan", model, "Plan the invoice."),
              modelStep("draft", model, "Write the invoice."),
            ],
          },
        }),
      }).catch(() => null);

      const running = await waitFor(
        async () => {
          if (!model.held()) return null;
          const [step] = await fixture.db.db
            .select({ execution_id: executionSteps.execution_id })
            .from(executionSteps)
            .where(and(eq(executionSteps.step_key, "draft"), eq(executionSteps.status, "running")));
          return step?.execution_id;
        },
        { tries: 1000, sleepMs: 20, label: "the second model turn is in flight" },
      );

      first.child.kill("SIGKILL");
      await first.exited();
      await run;
      expect(model.calls()).toBe(2);
      const [stuck] = await fixture.db.db
        .select({ status: executions.status })
        .from(executions)
        .where(eq(executions.id, running));
      expect(stuck?.status).toBe("running");

      const second = fixture.start(fixture.key, "crash-journey-second");
      await healthy(fixture, second);
      const recovered = await waitFor(
        async () => {
          const [row] = await fixture.db.db
            .select({ status: executions.status, failure: executions.failure })
            .from(executions)
            .where(and(eq(executions.tenant_id, tenantId), eq(executions.id, running)));
          return row && row.status !== "running" ? row : null;
        },
        { tries: 1000, sleepMs: 20, label: "the restarted engine recovers the run" },
      );
      expect(recovered.status).toBe("timed_out");
      expect(recovered.failure?.error_code).toBe("engine_crash_recovery");
      expect(model.calls()).toBe(2);

      const usage = await fixture.db.db
        .select({ total: llmUsage.total_tokens })
        .from(llmUsage)
        .where(and(eq(llmUsage.tenant_id, tenantId), eq(llmUsage.execution_id, running)));
      expect(usage).toEqual([{ total: 60 }]);

      const violations = await journeyInvariantViolations({
        db: fixture.db.db,
        knownSecrets: [apiKey, fixture.key],
        logs: () => [first.rawLogs(), second.rawLogs()],
        liveWorker: () => false,
      });
      expect(violations).toEqual([]);
    } finally {
      await fixture.cleanup();
      model.stop();
    }
  },
  PROCESS_TEST_TIMEOUT_MS * 2,
);
