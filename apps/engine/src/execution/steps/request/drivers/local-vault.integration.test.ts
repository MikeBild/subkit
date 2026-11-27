import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RUNNER_ROUTES } from "@shared/device/runner-wire.ts";
import { eq } from "drizzle-orm";
import { vaultPayments, vaultUses } from "../../../../db/schema/index.ts";
import {
  answer,
  approvedLocalRun,
  call,
  enroll,
  harness,
  type LocalStep,
  pendingCommand,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../../../../http/tests/device-runner-fixtures.ts";
import { getTestNow } from "../../../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../../../test-helpers/determinism/wait.ts";
import { approveVaultPayment, createVaultItem } from "../../../../vault/index.ts";
import type { StepResult } from "../../../types.ts";
import { DRIVERS } from "./registry.ts";

const ORIGIN = "https://shop.example";
const PASSWORD = "fixture-workflow-password-3d1a";
const PAGE = [
  '- textbox "E-Mail" [ref=e1]',
  '- textbox "Password" [ref=e2]',
  '- button "Sign in" [ref=e3]',
  '- textbox "Card number" [ref=e4]',
  '- button "Pay now" [ref=e5]',
].join("\n");
const SITE = {
  capability: "browser" as const,
  sites: [{ origin: ORIGIN, private: false, site_digest: "c".repeat(64) }],
};

let runner: Runner;

beforeAll(async () => {
  await setUpDeviceRunner("vault_workflow_steps");
  runner = await enroll("Workflow Mac");
  const viewer = {
    user_id: harness.server.userId,
    permissions: new Set(["vault:read", "vault:write"]),
  };
  const base = {
    tenant_id: harness.server.tenantId,
    actor: null,
    viewer,
    scope: "person" as const,
    environment: "prod" as const,
    description: null,
  };
  await createVaultItem(harness.server.db, {
    ...base,
    kind: "login",
    name: "shop",
    value: { kind: "login", username: "anna@shop.example", password: PASSWORD },
    origins: [ORIGIN],
  });
  await createVaultItem(harness.server.db, {
    ...base,
    kind: "card",
    name: "visa",
    value: {
      kind: "card",
      number: "4242424242424242",
      exp_month: 12,
      exp_year: 2031,
      holder: "Anna Beispiel",
    },
  });
}, 120_000);

afterAll(async () => {
  await tearDownDeviceRunner();
}, 30_000);

function run(execution_id: string, step: LocalStep): Promise<StepResult> {
  return DRIVERS.local_browser.execute({
    clock: { now: () => getTestNow() }, // allow-wall-clock: the server checks deadlines on its clock
    start: 0,
    signal: new AbortController().signal,
    connector: {
      id: "c0ffee00-0000-4000-8000-000000000002",
      config: { device_id: runner.device_id },
    },
    parts: { path: step.path, body: step.body },
    state: { holdThisStep: false },
    before_dispatch: async () => undefined,
    record_effect: () => undefined,
    p: {
      step: { id: step.id, kind: "request", method: step.method, path: step.path },
      ctx: {
        db: harness.server.db,
        tenant_id: harness.server.tenantId,
        execution_id,
        execution_mode: "prod",
        principal: null,
      },
    },
  } as unknown as Parameters<(typeof DRIVERS)["local_browser"]["execute"]>[0]);
}

async function snapshotThen(execution_id: string) {
  const snap = await pendingCommand(execution_id, "browser.snapshot");
  await answer(runner, snap.id, {
    status: "done",
    output: { snapshot: { snapshot: PAGE }, step: { origin: ORIGIN } },
    evidence: {},
  });
}

async function fill(execution_id: string, kind: string) {
  const command = await pendingCommand(execution_id, kind);
  const claimed = await call(runner, "POST", RUNNER_ROUTES.claim(command.id), {});
  const args = ((await claimed.json()) as { args: Record<string, unknown> }).args;
  const ticket = await call(runner, "POST", RUNNER_ROUTES.secretTicket(String(args.secret_ticket)));
  const values = ((await ticket.json()) as { values: Record<string, string> }).values;
  await call(runner, "POST", RUNNER_ROUTES.result(command.id), {
    status: "done",
    output: { filled: true, submitted: true, outcome: "submitted" },
    evidence: {},
  });
  return { args, values };
}

describe("workflow steps use the vault by reference", () => {
  test("browser.sign_in finds the elements, fills by ticket and records the use", async () => {
    const step: LocalStep = {
      id: "sign-in",
      method: "POST",
      path: "/browser.sign_in",
      body: {
        origin: ORIGIN,
        vault_item: "me.shop",
        username: { role: "textbox", name: "E-Mail" },
        password: { role: "textbox", name: "Password" },
        submit: { role: "button", name: "Sign in" },
      },
      device: SITE,
    };
    const execution_id = await approvedLocalRun(runner, [step], {
      request_source: "scheduler",
      schedule_created_by: harness.server.userId,
    });
    const running = run(execution_id, step);
    await snapshotThen(execution_id);
    const { args, values } = await fill(execution_id, "browser.sign_in");
    const result = await running;
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(args).toMatchObject({
      origin: ORIGIN,
      fields: { username: "e1", password: "e2", submit: "e3" },
    });
    expect(JSON.stringify(args)).not.toContain("me.shop");
    expect(values).toEqual({ username: "anna@shop.example", password: PASSWORD });
    const uses = await harness.server.db
      .select({ status: vaultUses.status })
      .from(vaultUses)
      .where(eq(vaultUses.run_id, execution_id));
    expect(uses).toEqual([{ status: "submitted" }]);
  });

  test("browser.pay waits for the owner's approval in every run", async () => {
    const step: LocalStep = {
      id: "pay",
      method: "POST",
      path: "/browser.pay",
      body: {
        origin: ORIGIN,
        card: "4242",
        amount_minor: 1299,
        currency: "EUR",
        number: { role: "textbox", name: "Card number" },
        submit: { role: "button", name: "Pay now" },
      },
      device: SITE,
    };
    const execution_id = await approvedLocalRun(runner, [step], {
      request_source: "scheduler",
      schedule_created_by: harness.server.userId,
    });
    const running = run(execution_id, step);
    await snapshotThen(execution_id);
    const payment = await waitFor(
      async () => {
        const [row] = await harness.server.db
          .select()
          .from(vaultPayments)
          .where(eq(vaultPayments.execution_id, execution_id));
        return row ?? null;
      },
      { sleepMs: 20, label: "payment request" },
    );
    expect(payment.status).toBe("pending");
    const approved = await approveVaultPayment(
      harness.server.db,
      {
        tenant_id: harness.server.tenantId,
        id: payment.id,
        actor_id: harness.server.userId,
        cvv: "737",
      },
      new Date(getTestNow()),
    );
    expect(approved.ok).toBe(true);
    const { values } = await fill(execution_id, "browser.pay");
    const result = await running;
    expect(values).toMatchObject({ number: "4242424242424242", cvv: "737" });
    expect(result).toMatchObject({
      status: "succeeded",
      output: { outcome: "submitted", note: "submitted, not confirmed paid — do not submit again" },
    });
  });
});
