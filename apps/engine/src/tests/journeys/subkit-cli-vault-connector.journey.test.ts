import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { type ArgsDef, type CommandDef, runCommand } from "citty";
import { decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { profileCommand } from "../../../../subkit/src/commands/profile.ts";
import { schedulesCommand } from "../../../../subkit/src/commands/schedules.ts";
import { vaultCommand } from "../../../../subkit/src/commands/vault.ts";
import { workflowsCommand } from "../../../../subkit/src/commands/workflows.ts";
import { type Captured, extractLastJson, patchStd, withNoExit } from "./cli-capture.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

const SLUG = "app-store-connect";
const signedJwt = {
  algorithm: "ES256",
  audience: "appstoreconnect-v1",
  issuer: "journey-issuer",
  key_id: "journey-key",
  ttl_seconds: 300,
};

let ctx: JourneyCtx;
let api: Server;
let dir = "";
let devKey = "";
let prodKey = "";
let devId = "";
let prodId = "";
let workflowId = "";
let scheduleId = "";
const authorizations: string[] = [];

beforeAll(async () => {
  ctx = await createJourneyCtx("subkit-cli-vault-connector", {
    envOverrides: {
      SUBKIT_ENGINE_URL: undefined,
      SUBKIT_API_KEY: undefined,
      SUBKIT_TENANT: undefined,
      SUBKIT_PROFILE: undefined,
    },
  });
  api = createServer((req, res) => {
    authorizations.push(String(req.headers.authorization ?? ""));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "beta-group", name: "Harmoniqs" }] }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  devKey = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
  prodKey = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
  for (const environment of ["dev", "prod"] as const) {
    const res = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "App Store Connect",
        slug: SLUG,
        driver: "http",
        environment,
        auth_type: "signed_jwt",
        base_url: base,
        config: { signed_jwt: signedJwt },
      }),
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    if (environment === "dev") devId = id;
    else prodId = id;
  }
  dir = mkdtempSync(path.join(tmpdir(), "subkit-cli-vault-"));
  writeFileSync(
    path.join(dir, "beta-groups.json"),
    JSON.stringify({
      name: "TestFlight beta groups",
      slug: "testflight-beta-groups",
      steps: [
        {
          kind: "request",
          id: "fetch_beta_group",
          connector_id: prodId,
          method: "GET",
          path: "/v1/betaGroups",
        },
      ],
    }),
  );
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function subkit<CommandArgs extends ArgsDef>(
  command: CommandDef<CommandArgs>,
  argv: string[],
  stdin?: string,
): Promise<Captured & { error: string }> {
  const saved = Object.getOwnPropertyDescriptor(process, "stdin");
  if (stdin !== undefined)
    Object.defineProperty(process, "stdin", { value: Readable.from([stdin]), configurable: true });
  const cli = patchStd();
  let error = "";
  try {
    await withNoExit(() => runCommand(command, { rawArgs: argv }).then(() => undefined));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    cli.restore();
    if (saved) Object.defineProperty(process, "stdin", saved);
  }
  return { stdout: cli.stdout, stderr: cli.stderr, error };
}

describe("a person stores the App Store key for the connector environment a schedule uses", () => {
  test("the person signs the CLI in with a key", async () => {
    await subkit(profileCommand, [
      "add",
      "--name",
      "journey",
      "--engine-url",
      ctx.baseUrl,
      "--api-key",
      ctx.apiKey,
    ]);
    await subkit(profileCommand, ["use", "journey"]);
    const created = await subkit(workflowsCommand, [
      "create",
      "--file",
      path.join(dir, "beta-groups.json"),
      "--json",
    ]);
    workflowId = (JSON.parse(extractLastJson(created.stdout)) as { id: string }).id;
    expect(workflowId).toBeTruthy();
  });

  test("attaching by slug alone is refused because dev and prod both exist", async () => {
    const refused = await subkit(vaultCommand, ["attach", SLUG, "--skip-checks"], devKey);
    expect(`${refused.error}${refused.stderr}`).toContain("--env dev or --env prod");
    const connector = await journeyFetch(ctx, `/v1/connectors/${devId}`);
    expect(((await connector.json()) as { credentials?: unknown[] }).credentials ?? []).toEqual([]);
  });

  test("attaching to dev names that record and warns that production has no credential", async () => {
    const attached = await subkit(
      vaultCommand,
      ["attach", SLUG, "--env", "dev", "--skip-checks"],
      devKey,
    );
    expect(attached.stdout).toContain(`credential attached to App Store Connect (${SLUG}, dev)`);
    expect(attached.stderr).toContain(`production connector '${SLUG}' has no credential`);
    expect(attached.stderr).toContain(`subkit vault attach ${SLUG} --env prod`);
  });

  test("the production schedule's readiness names the connector, prod and the command", async () => {
    const scheduled = await subkit(schedulesCommand, [
      "create",
      "--workflow",
      workflowId,
      "--cron",
      "0 6 1 1 *",
      "--executionMode",
      "prod",
    ]);
    expect(scheduled.error).toBe("");
    const listed = await journeyFetch(ctx, `/v1/schedules?workflow_id=${workflowId}`);
    scheduleId =
      ((await listed.json()) as { schedules: Array<{ id: string }> }).schedules[0]?.id ?? "";
    expect(scheduleId).toBeTruthy();
    expect(scheduled.stderr).toContain("automation: repair required");
    expect(scheduled.stderr).toContain("(prod)");
    expect(scheduled.stderr).toContain("fetch_beta_group");
    expect(scheduled.stderr).toContain(`"App Store Connect" (${SLUG}, prod)`);
    expect(scheduled.stderr).toContain(`subkit vault attach ${SLUG} --env prod`);

    const diagnosis = await journeyFetch(
      ctx,
      `/v1/workflows/${workflowId}/diagnosis?environment=prod`,
    );
    const body = (await diagnosis.json()) as {
      diagnoses: Array<Record<string, unknown>>;
    };
    expect(body.diagnoses).toContainEqual(
      expect.objectContaining({
        code: "connector_unavailable",
        subject: { step_id: "fetch_beta_group" },
        evidence: {
          connector: {
            connector_id: prodId,
            connector_slug: SLUG,
            connector_name: "App Store Connect",
            environment: "prod",
            reason: "credential_unavailable",
          },
        },
        remedy_kind: "reconnect",
        reconnect: { connector_id: prodId, environment: "prod", section: "credentials" },
      }),
    );
  });

  test("attaching with --env prod fills the production record", async () => {
    const attached = await subkit(
      vaultCommand,
      ["attach", SLUG, "--env", "prod", "--skip-checks", "--json"],
      prodKey,
    );
    const body = JSON.parse(extractLastJson(attached.stdout)) as {
      connector: { id: string; environment: string };
      warning?: string;
    };
    expect(body.connector).toMatchObject({ id: prodId, environment: "prod" });
    expect(body.warning).toBeUndefined();
  });

  test("the automation readiness of the production schedule is now eligible", async () => {
    const updated = await subkit(schedulesCommand, ["update", scheduleId, "--cron", "0 7 1 1 *"]);
    expect(updated.stderr).toContain("recurring runs can be approved (prod)");
    const diagnosis = await journeyFetch(
      ctx,
      `/v1/workflows/${workflowId}/diagnosis?environment=prod`,
    );
    const body = (await diagnosis.json()) as { diagnoses: Array<{ code: string }> };
    expect(body.diagnoses.map((entry) => entry.code)).not.toContain("connector_unavailable");
  });

  test("a production run signs its request with the production key", async () => {
    authorizations.length = 0;
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      headers: { "x-subkit-environment": "prod" },
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    const run = (await res.json()) as { status?: string; output?: unknown };
    expect(res.status).toBe(200);
    expect(run.status).toBe("succeeded");
    expect(run.output).toEqual({ data: [{ id: "beta-group", name: "Harmoniqs" }] });
    const [authorization] = authorizations;
    expect(authorization).toStartWith("Bearer ");
    const header = decodeProtectedHeader(String(authorization).slice("Bearer ".length));
    expect(header).toMatchObject({ alg: "ES256", kid: "journey-key" });
  });
});
