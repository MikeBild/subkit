import { and, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { conversations } from "../db/schema/index.ts";
import { admitWorkflowRun } from "../execution/workflow-run-admission.ts";
import { enqueueHostedWork } from "../queue/hosted-work.ts";
import { EXECUTION_RUN_QUEUE, type ExecutionRunJob } from "../queue/queues.ts";
import { workflowJsonDigest } from "../workflows/canonical-json.ts";
import { gateWorkflowRunRbac } from "../workflows/rbac.ts";
import { getWorkflow } from "../workflows/service.ts";
import { loadDraft } from "./draft.ts";
import { conversationExecutionSuppression } from "./execution-suppression.ts";

export async function continueConversationDevLiveTest(input: {
  db: Db;
  principal: ResolvedPrincipal;
  conversation_id: string | undefined;
  workflow_id: string;
  workflow_version_id: string;
  boss: PgBoss | undefined;
}): Promise<{
  state: "not_requested" | "blocked" | "queued" | "running" | "succeeded" | "failed";
  execution_id?: string;
}> {
  if (!input.conversation_id) return { state: "not_requested" };
  if (!input.boss) return { state: "blocked" };
  const [conversation] = await input.db
    .select({ owner_id: conversations.owner_id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, input.principal.tenant_id),
        eq(conversations.id, input.conversation_id),
      ),
    )
    .limit(1);
  if (
    !conversation ||
    (conversation.owner_id &&
      conversation.owner_id !== input.principal.id &&
      !input.principal.roles.includes("admin"))
  )
    return { state: "blocked" };
  if (
    (
      await conversationExecutionSuppression({
        db: input.db,
        tenant_id: input.principal.tenant_id,
        conversation_id: input.conversation_id,
      })
    ).live
  )
    return { state: "blocked" };
  const draft = await loadDraft(
    input.principal.tenant_id,
    input.conversation_id,
    input.db,
    input.principal,
  );
  const live_test = draft.session?.live_test;
  if (
    live_test?.environment !== "dev" ||
    live_test.workflow_id !== input.workflow_id ||
    live_test.workflow_version_id !== input.workflow_version_id ||
    live_test.input_digest !== workflowJsonDigest(live_test.input) ||
    live_test.state === "succeeded"
  )
    return { state: "not_requested" };
  const workflow = await getWorkflow(input.principal.tenant_id, input.workflow_id, input.db);
  if (!workflow || workflow.current_version_id !== input.workflow_version_id) {
    return { state: "blocked" };
  }
  const rbac = await gateWorkflowRunRbac({
    db: input.db,
    principal: input.principal,
    workflow_id: input.workflow_id,
    workflow_slug: workflow.slug,
    request_source: "chat",
    tool: "run_workflow",
  });
  if (!rbac.allow) {
    return { state: "blocked" };
  }
  try {
    const admitted = await admitWorkflowRun(
      {
        tenant_id: input.principal.tenant_id,
        workflow_id: input.workflow_id,
        workflow_version_id: input.workflow_version_id,
        expected_workflow_version_id: input.workflow_version_id,
        execution_environment: "dev",
        request_source: "chat",
        input: live_test.input,
        idempotency_key: live_test.idempotency_key,
      },
      input.db,
      input.principal,
      rbac.workflow_permission,
    );
    if (admitted.status !== "queued") {
      return {
        state:
          admitted.status === "succeeded"
            ? "succeeded"
            : admitted.status === "running"
              ? "running"
              : "failed",
        execution_id: admitted.execution_id,
      };
    }
    try {
      await enqueueHostedWork(
        input.db,
        input.boss,
        "execution",
        EXECUTION_RUN_QUEUE,
        {
          tenant_id: input.principal.tenant_id,
          workflow_id: input.workflow_id,
          execution_id: admitted.execution_id,
          request_source: "chat",
          execution_mode: "dev",
        } satisfies ExecutionRunJob,
        { id: admitted.execution_id },
      );
    } catch {
      return { state: "blocked", execution_id: admitted.execution_id };
    }
    return {
      state: "queued",
      execution_id: admitted.execution_id,
    };
  } catch {
    return { state: "blocked" };
  }
}
