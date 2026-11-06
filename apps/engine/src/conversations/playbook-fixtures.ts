import { afterAll, beforeAll } from "bun:test";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { connectors, conversations, conversationToolCalls, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { FROZEN_NOW, setTestNow } from "../test-helpers/determinism/clock.ts";
import type { PlaybookPlan, PlaybookStep } from "./playbook-contract.ts";
import type { PlaybookScope } from "./playbook-evidence.ts";

export let fixture: TestDb;
export let tenantId: string;
export let principal: ResolvedPrincipal;
export let sequence = 0;
export const timestamp = (offset = 0) => new Date(FROZEN_NOW + offset);
export const actorId = "00000000-0000-4000-8000-000000000101";

export async function scope(mode: "auto" | "off" = "auto"): Promise<PlaybookScope> {
  const [row] = await fixture.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active", playbook_mode: mode })
    .returning();
  if (!row) throw new Error("missing conversation");
  return { tenant_id: tenantId, conversation_id: row.id, principal };
}
export function step(
  criterion: PlaybookStep["criterion"],
  evidence_ids: string[] = [],
): PlaybookStep {
  return {
    id: "check",
    label: "Prüfen",
    criterion,
    evidence_ids,
    depends_on: [],
    progress: "open",
    note: null,
    next_action: null,
  };
}
export function plan(
  steps: PlaybookStep[],
  completion_step_id: string | null = null,
): PlaybookPlan {
  return {
    title: "Prüfung",
    goal: "Den Stand prüfen",
    steps,
    completion_step_id,
    cancelled: false,
  };
}
export async function call(scope: PlaybookScope, tool: string, output: unknown, outcome = "ok") {
  const [row] = await fixture.db
    .insert(conversationToolCalls)
    .values({
      tenant_id: scope.tenant_id,
      conversation_id: scope.conversation_id,
      tool,
      input: {},
      output,
      outcome,
      created_at: timestamp(1000),
    })
    .returning();
  if (!row) throw new Error("missing call");
  return row.id;
}
export async function connector() {
  const [row] = await fixture.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: `playbook-${++sequence}`,
      display_name: "Private source title",
      driver: "http",
      created_at: timestamp(),
      updated_at: timestamp(),
    })
    .returning();
  if (!row) throw new Error("missing connector");
  return row;
}

export function nextSequence(): number {
  return ++sequence;
}

export function usePlaybookSetup(): void {
  beforeAll(async () => {
    setTestNow(() => FROZEN_NOW);
    fixture = await createTestDb("playbook_contract");
    const [tenant] = await fixture.db
      .insert(tenants)
      .values({ slug: "playbook-tests", display_name: "Playbook tests" })
      .returning();
    if (!tenant) throw new Error("missing tenant");
    tenantId = tenant.id;
    principal = {
      id: actorId,
      kind: "user",
      tenant_id: tenantId,
      roles: ["admin"],
      provider: "test",
    };
  });

  afterAll(async () => {
    setTestNow(null);
    await fixture?.cleanup();
  });
}
