import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTaskWorld, MISSING, type TaskWorld, taskBody } from "./task-golden-world.ts";

let world: TaskWorld;
let taskId: string;
let fingerprint: string;
let grantId: string;
let owner: Record<string, string>;
let other: Record<string, string>;
let admin: Record<string, string>;
let enduser: Record<string, string>;
let noCsrf: Record<string, string>;
let crossSite: Record<string, string>;

const STALE = "0".repeat(64);

function inSevenDays(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(); // allow-wall-clock: grant window fixture
}

function grantBody(overrides: Record<string, unknown> = {}) {
  return {
    expected_fingerprint: fingerprint,
    valid_until: inSevenDays(),
    max_runs: 5,
    expected_workflow_digests: {},
    ...overrides,
  };
}

beforeAll(async () => {
  world = await createTaskWorld("operations_task_grants_golden", "task-grants");
  const created = await world.http(
    "POST",
    "/v1/tasks",
    taskBody({ schedule_cron: "0 8 * * 1", schedule_timezone: "Europe/Berlin" }),
  );
  expect(created.status).toBe(201);
  const task = created.body as { id: string; fingerprint: string };
  taskId = task.id;
  fingerprint = task.fingerprint;
  owner = await world.browser(world.owner);
  other = await world.browser(world.other);
  admin = await world.browser(world.admin);
  enduser = await world.browser(world.enduser);
  const { "x-subkit-csrf": _csrf, ...withoutCsrf } = owner;
  noCsrf = withoutCsrf;
  crossSite = { ...owner, "sec-fetch-site": "cross-site" };
}, 120_000);

afterAll(async () => {
  await world.cleanup();
});

describe("task grant operations keep their HTTP responses byte for byte", () => {
  test("permission is checked before the session and the body", async () => {
    const { http, record, denied } = world;
    const base = `/v1/tasks/${taskId}`;
    record(
      "http.denied.preview",
      await http("GET", `${base}/grant-preview`, undefined, denied.key),
    );
    record("http.denied.list", await http("GET", `${base}/grants`, undefined, denied.key));
    record("http.denied.grant", await http("POST", `${base}/grants`, {}, denied.key));
    record(
      "http.denied.revoke",
      await http("POST", `${base}/grants/${MISSING}/revoke`, undefined, denied.key),
    );
    record("http.enduser.grant", await http("POST", `${base}/grants`, grantBody(), enduser));
    record(
      "http.enduser.revoke",
      await http("POST", `${base}/grants/${MISSING}/revoke`, undefined, enduser),
    );
  });

  test("an API key cannot preview, give or revoke a standing permission", async () => {
    const { http, record, admin: adminPerson } = world;
    const base = `/v1/tasks/${taskId}`;
    record("http.key.preview", await http("GET", `${base}/grant-preview`));
    record("http.key.grant", await http("POST", `${base}/grants`, grantBody()));
    record("http.key.revoke", await http("POST", `${base}/grants/${MISSING}/revoke`));
    record(
      "http.key.admin.grant",
      await http("POST", `${base}/grants`, grantBody(), adminPerson.key),
    );
    record("http.key.list", await http("GET", `${base}/grants`));
  });

  test("the preview needs a browser session on the same site, but no CSRF proof", async () => {
    const { http, record } = world;
    const base = `/v1/tasks/${taskId}`;
    const preview = await http("GET", `${base}/grant-preview`, undefined, noCsrf);
    expect(preview.status).toBe(200);
    record("http.no-csrf.preview", preview);
    const foreign = await http("GET", `${base}/grant-preview`, undefined, crossSite);
    expect(foreign.status).toBe(403);
    record("http.cross-site.preview", foreign);
  });

  test("giving and revoking need the CSRF proof and the same site", async () => {
    const { http, record } = world;
    const base = `/v1/tasks/${taskId}`;
    record("http.no-csrf.grant", await http("POST", `${base}/grants`, grantBody(), noCsrf));
    record("http.cross-site.grant", await http("POST", `${base}/grants`, grantBody(), crossSite));
    record(
      "http.cross-site.revoke",
      await http("POST", `${base}/grants/${MISSING}/revoke`, undefined, crossSite),
    );
  });

  test("preview", async () => {
    const { http, record } = world;
    record(
      "http.preview",
      await http("GET", `/v1/tasks/${taskId}/grant-preview`, undefined, owner),
    );
    record(
      "http.preview.other",
      await http("GET", `/v1/tasks/${taskId}/grant-preview`, undefined, other),
    );
    record(
      "http.preview.admin",
      await http("GET", `/v1/tasks/${taskId}/grant-preview`, undefined, admin),
    );
    record(
      "http.preview.missing",
      await http("GET", `/v1/tasks/${MISSING}/grant-preview`, undefined, owner),
    );
  });

  test("grant", async () => {
    const { http, record } = world;
    const path = `/v1/tasks/${taskId}/grants`;
    record("http.grant.invalid", await http("POST", path, { max_runs: 0 }, owner));
    record(
      "http.grant.stale",
      await http("POST", path, grantBody({ expected_fingerprint: STALE }), owner),
    );
    record(
      "http.grant.window",
      await http("POST", path, grantBody({ valid_until: "2020-01-01T00:00:00.000Z" }), owner),
    );
    record("http.grant.other", await http("POST", path, grantBody(), other));
    record(
      "http.grant.missing",
      await http("POST", `/v1/tasks/${MISSING}/grants`, grantBody(), owner),
    );
    const until = inSevenDays();
    const granted = await http("POST", path, grantBody({ valid_until: until }), owner);
    grantId = (granted.body as { grant: { id: string } }).grant.id;
    record("http.grant", granted);
    record(
      "http.grant.identical",
      await http("POST", path, grantBody({ valid_until: until }), owner),
    );
    record("http.list", await http("GET", path, undefined, owner));
    record("http.list.other", await http("GET", path, undefined, other));
    record(
      "http.preview.granted",
      await http("GET", `/v1/tasks/${taskId}/grant-preview`, undefined, owner),
    );
  });

  test("revoke", async () => {
    const { http, record } = world;
    const base = `/v1/tasks/${taskId}/grants`;
    record("http.revoke.other", await http("POST", `${base}/${grantId}/revoke`, undefined, other));
    record(
      "http.revoke.missing",
      await http("POST", `${base}/${MISSING}/revoke`, undefined, owner),
    );
    record(
      "http.revoke.invalid",
      await http("POST", `${base}/not-a-uuid/revoke`, undefined, owner),
    );
    record("http.revoke", await http("POST", `${base}/${grantId}/revoke`, undefined, owner));
    record("http.revoke.again", await http("POST", `${base}/${grantId}/revoke`, undefined, owner));
  });

  test("an admin may give and revoke the standing permission of another person's task", async () => {
    const { http, record } = world;
    const base = `/v1/tasks/${taskId}/grants`;
    const granted = await http(
      "POST",
      base,
      grantBody({ valid_until: null, max_runs: null }),
      admin,
    );
    record("http.grant.admin", granted);
    const id = (granted.body as { grant: { id: string } }).grant.id;
    record("http.revoke.admin", await http("POST", `${base}/${id}/revoke`, undefined, admin));
    record("http.list.after", await http("GET", base, undefined, owner));
  });

  test("a content change ends the standing permission", async () => {
    const { http, record } = world;
    const base = `/v1/tasks/${taskId}/grants`;
    const granted = await http("POST", base, grantBody(), owner);
    expect(granted.status).toBe(201);
    const updated = await http("PUT", `/v1/tasks/${taskId}`, {
      ...taskBody({ schedule_cron: "0 8 * * 1", schedule_timezone: "Europe/Berlin" }),
      done_when: "The report was sent",
      expected_revision: 1,
    });
    expect((updated.body as { grant_invalidated: boolean }).grant_invalidated).toBe(true);
    record("http.grant.after-change", await http("POST", base, grantBody(), owner));
    const live = (await http("GET", base, undefined, owner)).body as {
      items: Array<{ revoked_at: string | null }>;
    };
    expect(live.items.every((grant) => grant.revoked_at !== null)).toBe(true);
  });

  test("audit rows name the granting person", async () => {
    const { record, auditTrail } = world;
    record("http.audit.grant", await auditTrail(grantId));
  });

  test("the golden file has no stale entries", () => {
    const keys = world.staleKeys();
    expect(keys.actual).toEqual(keys.golden);
  });
});
