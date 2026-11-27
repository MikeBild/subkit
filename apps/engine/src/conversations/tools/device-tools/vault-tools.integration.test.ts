import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { localConfirmationOf } from "@shared/device/confirmation.ts";
import type { DeviceResult } from "@shared/device/protocol.ts";
import { RUNNER_ROUTES } from "@shared/device/runner-wire.ts";
import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import {
  conversationElicitations,
  conversationToolCalls,
  deviceAllowances,
  deviceCommands,
  vaultPayments,
} from "../../../db/schema/index.ts";
import { conversationCommandId } from "../../../devices/core/command-id.ts";
import {
  call,
  enroll,
  harness,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../../../http/tests/device-runner-fixtures.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import { makeToolCtx, seedConversation } from "../../../test-helpers/seed.ts";
import { approveVaultPayment, createVaultItem } from "../../../vault/index.ts";
import { deviceToolSpec } from "../../core/device-tools/catalog.ts";
import { appendMessage, insertToolCall } from "../../persistence/index.ts";
import type { ToolResult } from "../index.ts";
import { deviceConfirmationPort } from "./port.ts";
import { executeDeviceTool } from "./run.ts";

const ORIGIN = "https://shop.example";
const PASSWORD = "fixture-shop-password-5c2e";
const PAN = "4242424242424242";
const CVV = "737";
const PAGE = [
  '- textbox "E-Mail" [ref=e1]',
  '- textbox "Password" [ref=e2]',
  '- button "Sign in" [ref=e3]',
  '- textbox "Card number" [ref=e4]',
  '- button "Pay now" [ref=e5]',
].join("\n");

let runner: Runner;

beforeAll(async () => {
  await setUpDeviceRunner("vault_tools");
  runner = await enroll("MacBook (Anna)");
  const beat = await call(runner, "POST", "/v1/device-runner/heartbeat", {
    runner_version: "13.4.0",
    os: "darwin",
    capabilities: ["browser"],
    personal: ["browser"],
    permissions: {},
    allowances_digest: "x",
    generation: 0,
  });
  expect(beat.status).toBeLessThan(300);
  await harness.server.db.insert(deviceAllowances).values({
    tenant_id: harness.server.tenantId,
    device_runner_id: runner.device_id,
    kind: "site",
    item_id: "shop",
    display: ORIGIN,
    digest: "c".repeat(64),
    private: false,
    entered_by: "person",
  });
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
    value: { kind: "card", number: PAN, exp_month: 12, exp_year: 2031, holder: "Anna Beispiel" },
  });
}, 120_000);

afterAll(async () => {
  await tearDownDeviceRunner();
}, 30_000);

function person(): ResolvedPrincipal {
  return {
    provider: "browser_session",
    kind: "user",
    id: harness.server.userId,
    tenant_id: harness.server.tenantId,
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: "session-vault-tools" },
  };
}

async function chat(message: string) {
  const conversation = await seedConversation(harness.server.db, {
    tenant_id: harness.server.tenantId,
    owner_id: harness.server.userId,
  });
  await appendMessage(harness.server.db, harness.server.tenantId, conversation.id, "user", {
    text: message,
  });
  return conversation.id;
}

async function commandRow(command_id: string) {
  const [row] = await harness.server.db
    .select()
    .from(deviceCommands)
    .where(
      and(eq(deviceCommands.tenant_id, harness.server.tenantId), eq(deviceCommands.id, command_id)),
    );
  return row;
}

type Respond = (args: Record<string, unknown>) => Promise<DeviceResult> | DeviceResult;

async function answer(command_id: string, respond: Respond) {
  await waitFor(async () => (await commandRow(command_id))?.state === "pending", { sleepMs: 20 });
  const claimed = await call(runner, "POST", RUNNER_ROUTES.claim(command_id), {});
  const command = (await claimed.json()) as { args: Record<string, unknown> };
  await call(runner, "POST", RUNNER_ROUTES.result(command_id), await respond(command.args));
}

async function invoke(
  conversation_id: string,
  name: string,
  input: Record<string, unknown>,
  respond: Respond | null,
): Promise<{ result: ToolResult; tool_call_id: string; command_id: string }> {
  const db = harness.server.db;
  const tool_call_id = await insertToolCall(db, {
    tenant_id: harness.server.tenantId,
    conversation_id,
    tool: name,
    input,
    approval_required: false,
  });
  const command_id = conversationCommandId({
    owner_kind: "conversation",
    owner_id: conversation_id,
    tool_call_id,
  });
  const spec = deviceToolSpec(name);
  if (!spec) throw new Error(name);
  const running = executeDeviceTool(
    db,
    spec,
    makeToolCtx({
      db,
      tenant_id: harness.server.tenantId,
      conversation_id,
      actor_id: harness.server.userId,
      principal: person(),
      surface: "web",
      tool_call_id,
      locale: "de",
    }),
    input,
  );
  if (respond) await answer(command_id, respond);
  return { result: await running, tool_call_id, command_id };
}

const done = (output: unknown): DeviceResult => ({ status: "done", output, evidence: {} });

async function snapshot(conversation_id: string, origin = ORIGIN) {
  const taken = await invoke(conversation_id, "browser_snapshot", {}, () =>
    done({ snapshot: { snapshot: PAGE }, step: { origin } }),
  );
  return taken.tool_call_id;
}

async function ticketValues(args: Record<string, unknown>): Promise<Record<string, string>> {
  const claimed = await call(
    runner,
    "POST",
    RUNNER_ROUTES.secretTicket(String(args.secret_ticket)),
  );
  expect(claimed.status).toBe(200);
  return ((await claimed.json()) as { values: Record<string, string> }).values;
}

async function storedText(): Promise<string> {
  const parts: string[] = [];
  for (const table of [
    "device_commands",
    "conversation_tool_calls",
    "conversation_elicitations",
    "vault_uses",
    "vault_payments",
    "vault_secret_tickets",
    "audit_log",
  ]) {
    const rows = await harness.server.db.execute<{ dump: string | null }>(
      sql.raw(
        `SELECT coalesce(string_agg(t::text, ' '), '') AS dump FROM "${table}" t WHERE t.tenant_id = '${harness.server.tenantId}'`,
      ),
    );
    parts.push(rows.rows[0]?.dump ?? "");
  }
  return parts.join("\n");
}

describe("browser_sign_in fills a vault login without the model seeing it", () => {
  test("the person's own words cover the sign-in; the device gets only a ticket", async () => {
    const conversation_id = await chat("Melde dich bei shop.example an");
    const snapshot_id = await snapshot(conversation_id);
    let seen: Record<string, unknown> = {};
    let values: Record<string, string> = {};
    const { result, command_id } = await invoke(
      conversation_id,
      "browser_sign_in",
      {
        snapshot_id,
        origin: ORIGIN,
        vault_item: "me.shop",
        username_ref: "e1",
        password_ref: "e2",
        submit_ref: "e3",
        because: "Melde dich bei shop.example an",
      },
      async (args) => {
        seen = args;
        values = await ticketValues(args);
        return done({
          filled: true,
          submitted: true,
          outcome: "submitted",
          snapshot: { snapshot: `- text "Signed in as anna, ${PASSWORD}" [ref=e9]` },
        });
      },
    );
    expect(values).toEqual({ username: "anna@shop.example", password: PASSWORD });
    expect(seen).toMatchObject({
      origin: ORIGIN,
      kind: "password",
      fields: { username: "e1", password: "e2", submit: "e3" },
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(result).toMatchObject({ data: { filled: true, submitted: true, outcome: "submitted" } });
    expect(JSON.stringify((await commandRow(command_id))?.args)).not.toContain(PASSWORD);
    expect(await storedText()).not.toContain(PASSWORD);
  });

  test("a look-alike site is refused before anything reaches the device", async () => {
    const lookalike = "https://shop-example.evil.test";
    const conversation_id = await chat("Melde dich bei shop.example an");
    const snapshot_id = await snapshot(conversation_id, lookalike);
    const { result, command_id } = await invoke(
      conversation_id,
      "browser_sign_in",
      { snapshot_id, origin: lookalike, vault_item: "me.shop", password_ref: "e2" },
      null,
    );
    expect(result).toMatchObject({ ok: false, error_code: "origin_not_bound" });
    expect(await commandRow(command_id)).toBeUndefined();
  });

  test("without the person's words it asks first and holds no ticket while waiting", async () => {
    const conversation_id = await chat("Schau dir den Shop an");
    const snapshot_id = await snapshot(conversation_id);
    const { result, tool_call_id } = await invoke(
      conversation_id,
      "browser_sign_in",
      { snapshot_id, origin: ORIGIN, vault_item: "me.shop", password_ref: "e2" },
      null,
    );
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    const [row] = await harness.server.db
      .select({ data: conversationToolCalls.confirmation_data })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, tool_call_id));
    expect(JSON.stringify(row?.data)).not.toContain("secret_ticket");
  });
});

describe("browser_pay waits for the owner's security code", () => {
  async function requestPay(conversation_id: string) {
    const snapshot_id = await snapshot(conversation_id);
    return await invoke(
      conversation_id,
      "browser_pay",
      {
        snapshot_id,
        origin: ORIGIN,
        card: "4242",
        amount_minor: 1299,
        currency: "EUR",
        number_ref: "e4",
        submit_ref: "e5",
        because: "Bezahle bei shop.example",
      },
      null,
    );
  }

  async function confirmation(tool_call_id: string) {
    const [elicitation] = await harness.server.db
      .select()
      .from(conversationElicitations)
      .where(eq(conversationElicitations.tool_call_id, tool_call_id));
    const found = localConfirmationOf(elicitation?.input);
    if (!found) throw new Error("no confirmation");
    return found;
  }

  async function paymentOf(tool_call_id: string) {
    const [row] = await harness.server.db
      .select()
      .from(vaultPayments)
      .where(eq(vaultPayments.tool_call_id, tool_call_id));
    if (!row) throw new Error("no payment");
    return row;
  }

  test("a plain confirmation without the code pays nothing", async () => {
    const conversation_id = await chat("Bezahle bei shop.example");
    const { result, tool_call_id, command_id } = await requestPay(conversation_id);
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(result.pause?.input).toMatchObject({
      target: { args: { payment_id: (await paymentOf(tool_call_id)).id } },
    });
    await deviceConfirmationPort(harness.server.db).settled({
      tenant_id: harness.server.tenantId,
      confirmation_id: tool_call_id,
      confirmation: await confirmation(tool_call_id),
      state: "granted",
    });
    expect(await commandRow(command_id)).toBeUndefined();
    expect((await paymentOf(tool_call_id)).status).toBe("rejected");
  });

  test("the approved payment runs once, submitted is not paid, nothing is stored", async () => {
    const conversation_id = await chat("Bezahle bei shop.example");
    const { tool_call_id, command_id } = await requestPay(conversation_id);
    const payment = await paymentOf(tool_call_id);
    const approved = await approveVaultPayment(
      harness.server.db,
      {
        tenant_id: harness.server.tenantId,
        id: payment.id,
        actor_id: harness.server.userId,
        cvv: CVV,
      },
      new Date(getTestNow()),
    );
    expect(approved.ok).toBe(true);
    let values: Record<string, string> = {};
    const settled = deviceConfirmationPort(harness.server.db).settled({
      tenant_id: harness.server.tenantId,
      confirmation_id: tool_call_id,
      confirmation: await confirmation(tool_call_id),
      state: "granted",
    });
    await answer(
      conversationCommandId({
        owner_kind: "conversation",
        owner_id: conversation_id,
        tool_call_id: `${tool_call_id}:recheck`,
      }),
      () => done({ snapshot: { snapshot: PAGE }, step: { origin: ORIGIN } }),
    );
    await answer(command_id, async (args) => {
      values = await ticketValues(args);
      expect(args.page_fingerprint).toBe(payment.page_fingerprint);
      return done({ filled: true, submitted: true, outcome: "submitted" });
    });
    await settled;
    expect(values).toMatchObject({ number: PAN, cvv: CVV });
    const [row] = await harness.server.db
      .select({ output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.id, tool_call_id));
    expect(row?.output).toMatchObject({
      outcome: "submitted",
      note: "submitted, not confirmed paid — do not submit again",
    });
    expect((await paymentOf(tool_call_id)).status).toBe("consumed");
    const stored = await storedText();
    for (const secret of [PAN, PASSWORD, '"cvv"']) expect(stored).not.toContain(secret);
    const again = await requestPay(conversation_id);
    expect(again.result).toMatchObject({ ok: false, error_code: "already_used" });
  });
});
