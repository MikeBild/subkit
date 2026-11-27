import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RUNNER_ROUTES } from "@shared/device/runner-wire.ts";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  deviceCommands,
  vaultPayments,
  vaultSecretTickets,
  vaultUses,
} from "../../db/schema/index.ts";
import { openDeviceCommand } from "../../devices/channel.ts";
import {
  call,
  enroll,
  harness,
  type Runner,
  setUpDeviceRunner,
  tearDownDeviceRunner,
} from "../../http/tests/device-runner-fixtures.ts";
import { browserSessionHeaders, type HttpTestServer } from "../../http/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { adminPrincipal } from "../../test-helpers/principals.ts";
import { resolveVaultItemForUse } from "../persistence/use.ts";
import { createVaultItem } from "../service.ts";
import {
  approveVaultPayment,
  claimSecretTicket,
  consumeApprovedPayment,
  mintSignInTicket,
  priorUseBlocks,
  requestVaultPayment,
  settleVaultUse,
} from "./index.ts";

const PASSWORD = "fixture-shop-password-91f3";
const PAN = "4242424242424242";
const CVV = "737";
const ORIGIN = "https://shop.example";
const nextId = createDeterministicUuidFactory(0x7a018);

let server: HttpTestServer;
let runner: Runner;
let other: Runner;
let login_id: string;
let login_digest: string;
let card_id: string;
let card_digest: string;
let counter = 0;

function commandId(): string {
  return createHash("sha256").update(`vault-use-${++counter}`).digest("hex");
}

async function open(command_id: string, kind: "browser.sign_in" | "browser.pay", args: object) {
  await openDeviceCommand(server.db, {
    command_id,
    tenant_id: server.tenantId,
    device_id: runner.device_id,
    execution_id: null,
    task_run_id: nextId(),
    step_id: kind,
    authority_id: null,
    manifest_digest: null,
    kind,
    args,
    deadline_at: new Date(getTestNow() + 60_000), // allow-wall-clock: the server checks deadlines on its clock
  });
}

async function dump(): Promise<string> {
  const tables = [
    "device_commands",
    "vault_uses",
    "vault_payments",
    "vault_secret_tickets",
    "audit_log",
    "conversation_tool_calls",
    "conversation_elicitations",
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await server.db.execute<{ dump: string | null }>(
      sql.raw(
        `SELECT coalesce(string_agg(t::text, ' '), '') AS dump FROM "${table}" t WHERE t.tenant_id = '${server.tenantId}'`,
      ),
    );
    parts.push(rows.rows[0]?.dump ?? "");
  }
  return parts.join("\n");
}

function start(command_id: string, device_id = runner.device_id) {
  return {
    tenant_id: server.tenantId,
    actor_id: server.userId,
    origin: ORIGIN,
    conversation_id: null,
    run_id: nextId(),
    task_id: null,
    device_id,
    command_id,
  };
}

beforeAll(async () => {
  server = await setUpDeviceRunner("vault_uses");
  runner = await enroll("Vault Mac");
  other = await enroll("Other Mac");
  const viewer = { user_id: server.userId, permissions: new Set(["vault:read", "vault:write"]) };
  const principal = adminPrincipal(server.tenantId, server.userId);
  await createVaultItem(server.db, {
    tenant_id: server.tenantId,
    actor: null,
    viewer,
    kind: "login",
    name: "shop",
    scope: "person",
    environment: "prod",
    description: null,
    value: { kind: "login", username: "anna@shop.example", password: PASSWORD },
    origins: [ORIGIN],
  });
  await createVaultItem(server.db, {
    tenant_id: server.tenantId,
    actor: null,
    viewer,
    kind: "card",
    name: "visa",
    scope: "person",
    environment: "prod",
    description: null,
    value: { kind: "card", number: PAN, exp_month: 12, exp_year: 2031, holder: "Anna Beispiel" },
  });
  const login = await resolveVaultItemForUse(server.db, {
    tenant_id: server.tenantId,
    principal,
    name: "me.shop",
    kind: "login",
    environment: "prod",
  });
  const card = await resolveVaultItemForUse(server.db, {
    tenant_id: server.tenantId,
    principal,
    name: "me.visa",
    kind: "card",
    environment: "prod",
  });
  login_id = login.item_id;
  login_digest = login.value_digest;
  card_id = card.item_id;
  card_digest = card.value_digest;
});

afterAll(async () => {
  await tearDownDeviceRunner();
});

describe("a secret ticket hands the values to one device, once, while its command runs", () => {
  test("claim order: command first, then the ticket, then never again", async () => {
    const command_id = commandId();
    const own = start(command_id);
    const minted = await mintSignInTicket(
      server.db,
      own,
      {
        item_id: login_id,
        value_digest: login_digest,
        kind: "password",
        fields: { username: "e1", password: "e2" },
      },
      new Date(getTestNow()),
    );
    if (!minted.ok) throw new Error(minted.code);
    await open(command_id, "browser.sign_in", {
      origin: ORIGIN,
      fields: { username: "e1", password: "e2", submit: "e3" },
      secret_ticket: minted.ticket_id,
      kind: "password",
    });
    const early = await call(runner, "POST", RUNNER_ROUTES.secretTicket(minted.ticket_id));
    expect(early.status).toBe(409);
    const stranger = await call(other, "POST", RUNNER_ROUTES.secretTicket(minted.ticket_id));
    expect(stranger.status).toBe(404);
    expect((await call(runner, "POST", RUNNER_ROUTES.claim(command_id))).status).toBe(200);
    const claimed = await call(runner, "POST", RUNNER_ROUTES.secretTicket(minted.ticket_id));
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get("cache-control")).toBe("no-store");
    const body = (await claimed.json()) as { values: Record<string, string> };
    expect(body.values).toEqual({ username: "anna@shop.example", password: PASSWORD });
    const again = await call(runner, "POST", RUNNER_ROUTES.secretTicket(minted.ticket_id));
    expect(again.status).toBe(410);
    const [use] = await server.db
      .select({ status: vaultUses.status })
      .from(vaultUses)
      .where(eq(vaultUses.id, minted.use_id));
    expect(use?.status).toBe("running");
    await settleVaultUse(server.db, {
      tenant_id: server.tenantId,
      use_id: minted.use_id,
      status: "uncertain",
      actor_id: server.userId,
    });
    expect(
      await priorUseBlocks(server.db, {
        tenant_id: server.tenantId,
        item_id: login_id,
        purpose: "sign_in",
        origin: ORIGIN,
        conversation_id: null,
        run_id: own.run_id,
      }),
    ).toBe(true);
    const [audit] = await server.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.resource_id, login_id)))
      .orderBy(sql`${auditLog.ts} desc`)
      .limit(1);
    expect(audit?.metadata).toMatchObject({
      purpose: "sign_in",
      origin: ORIGIN,
      use_id: minted.use_id,
      outcome: "uncertain",
    });
  });

  test("the same command can never mint a second use", async () => {
    const command_id = commandId();
    const intent = {
      item_id: login_id,
      value_digest: login_digest,
      kind: "password" as const,
      fields: { password: "e2" },
    };
    expect(
      (await mintSignInTicket(server.db, start(command_id), intent, new Date(getTestNow()))).ok,
    ).toBe(true);
    expect(
      await mintSignInTicket(server.db, start(command_id), intent, new Date(getTestNow())),
    ).toEqual({
      ok: false,
      code: "already_used",
    });
  });

  test("an expired ticket is gone and its use failed without filling anything", async () => {
    const command_id = commandId();
    const minted = await mintSignInTicket(
      server.db,
      start(command_id),
      {
        item_id: login_id,
        value_digest: login_digest,
        kind: "password",
        fields: { password: "e2" },
      },
      new Date(getTestNow() - 120_000), // allow-wall-clock: an already expired ticket
    );
    if (!minted.ok) throw new Error(minted.code);
    const claimed = await claimSecretTicket(
      server.db,
      { tenant_id: server.tenantId, device_id: runner.device_id, ticket_id: minted.ticket_id },
      new Date(getTestNow()),
    );
    expect(claimed).toEqual({ ok: false, status: 410, code: "ticket_gone" });
    const [use] = await server.db
      .select({ status: vaultUses.status })
      .from(vaultUses)
      .where(eq(vaultUses.id, minted.use_id));
    expect(use?.status).toBe("failed");
  });

  test("a changed login refuses the old approval", async () => {
    const minted = await mintSignInTicket(
      server.db,
      start(commandId()),
      { item_id: login_id, value_digest: "0".repeat(64), kind: "password", fields: {} },
      new Date(getTestNow()),
    );
    expect(minted).toEqual({ ok: false, code: "vault_item_changed" });
  });
});

describe("a payment needs the owner's security code and runs once", () => {
  async function request(command_id: string) {
    return await requestVaultPayment(
      server.db,
      {
        tenant_id: server.tenantId,
        owner_user_id: server.userId,
        card_item_id: card_id,
        card_value_digest: card_digest,
        card_brand: "visa",
        card_last4: "4242",
        origin: ORIGIN,
        page_fingerprint: "f".repeat(64),
        fields: { number: "e4", submit: "e5" },
        field_frames: { number: ORIGIN, submit: ORIGIN },
        submit_ref: "e5",
        amount_minor: 1299,
        currency: "EUR",
        device_id: runner.device_id,
        command_id,
        conversation_id: null,
        tool_call_id: null,
        task_run_id: null,
        execution_id: null,
      },
      new Date(getTestNow()),
    );
  }

  test("the owner approves over HTTP, the ticket carries the code, nothing stores it", async () => {
    const command_id = commandId();
    const payment = await request(command_id);
    expect(
      await consumeApprovedPayment(
        server.db,
        { tenant_id: server.tenantId, command_id },
        new Date(getTestNow()),
      ),
    ).toEqual({ ok: false, code: "payment_not_approved" });
    const headers = await browserSessionHeaders(server, server.userId);
    const listed = await fetch(`${harness.server.baseUrl}/v1/vault/payments?status=pending`, {
      headers,
    });
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as { items: { id: string; card: unknown }[] };
    expect(list.items.find((item) => item.id === payment.id)?.card).toEqual({
      brand: "visa",
      last4: "4242",
    });
    const approved = await fetch(
      `${harness.server.baseUrl}/v1/vault/payments/${payment.id}/approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ cvv: CVV }),
      },
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      payment: { id: payment.id, status: "approved" },
      resume: null,
    });
    const twice = await fetch(`${harness.server.baseUrl}/v1/vault/payments/${payment.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cvv: CVV }),
    });
    expect(twice.status).toBe(409);
    const consumed = await consumeApprovedPayment(
      server.db,
      { tenant_id: server.tenantId, command_id },
      new Date(getTestNow()),
    );
    if (!consumed.ok) throw new Error(consumed.code);
    await open(command_id, "browser.pay", {
      origin: ORIGIN,
      page_fingerprint: "f".repeat(64),
      fields: { number: "e4", submit: "e5" },
      field_frames: { number: ORIGIN, submit: ORIGIN },
      secret_ticket: consumed.ticket_id,
      amount_minor: 1299,
      currency: "EUR",
    });
    const stored = await dump();
    for (const secret of [PAN, "4242 4242 4242 4242", '"cvv"', PASSWORD]) {
      expect(stored).not.toContain(secret);
    }
    const [row] = await server.db
      .select({ args: deviceCommands.args })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, command_id));
    expect(JSON.stringify(row)).not.toContain(PAN);
    expect((await call(runner, "POST", RUNNER_ROUTES.claim(command_id))).status).toBe(200);
    const ticket = await call(runner, "POST", RUNNER_ROUTES.secretTicket(consumed.ticket_id));
    expect(((await ticket.json()) as { values: Record<string, string> }).values).toMatchObject({
      number: PAN,
      cvv: CVV,
      exp_month: "12",
      exp_year: "2031",
    });
    const tickets = await server.db
      .select({ id: vaultSecretTickets.id })
      .from(vaultSecretTickets)
      .where(eq(vaultSecretTickets.id, consumed.ticket_id));
    expect(tickets).toEqual([]);
    expect(
      await consumeApprovedPayment(
        server.db,
        { tenant_id: server.tenantId, command_id },
        new Date(getTestNow()),
      ),
    ).toEqual({ ok: false, code: "payment_not_approved" });
  });

  test("another person cannot approve, a bad code is refused", async () => {
    const payment = await request(commandId());
    expect(
      await approveVaultPayment(
        server.db,
        { tenant_id: server.tenantId, id: payment.id, actor_id: nextId(), cvv: CVV },
        new Date(getTestNow()),
      ),
    ).toEqual({ ok: false, code: "not_card_owner" });
    const headers = await browserSessionHeaders(server, server.userId);
    const bad = await fetch(`${harness.server.baseUrl}/v1/vault/payments/${payment.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cvv: "12" }),
    });
    expect(bad.status).toBe(400);
    const runnerCall = await call(runner, "POST", `/v1/vault/payments/${payment.id}/approve`, {
      cvv: CVV,
    });
    expect([401, 403]).toContain(runnerCall.status);
  });

  test("an expired request cannot be approved", async () => {
    const payment = await request(commandId());
    await server.db
      .update(vaultPayments)
      .set({ expires_at: new Date(getTestNow() - 1000) }) // allow-wall-clock: an expired request
      .where(eq(vaultPayments.id, payment.id));
    expect(
      await approveVaultPayment(
        server.db,
        { tenant_id: server.tenantId, id: payment.id, actor_id: server.userId, cvv: CVV },
        new Date(getTestNow()),
      ),
    ).toEqual({ ok: false, code: "payment_not_pending" });
    const [row] = await server.db
      .select({ status: vaultPayments.status })
      .from(vaultPayments)
      .where(eq(vaultPayments.id, payment.id));
    expect(row?.status).toBe("expired");
  });
});
