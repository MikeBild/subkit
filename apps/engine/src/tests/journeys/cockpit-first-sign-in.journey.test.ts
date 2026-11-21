import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Attention,
  attentionBadge,
  overviewSections,
  overviewView,
} from "../../../../cockpit/src/features/overview/model/attention-projection.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;
const jar = new Map<string, string>();
let csrf = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("cockpit-first-sign-in");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function browser(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "text/html");
  if (jar.size > 0) {
    headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  const res = await fetch(new URL(path, ctx.baseUrl), { ...init, headers, redirect: "manual" });
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    jar.set(pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1));
  }
  return res;
}

function cockpit(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET" && csrf) {
    headers.set("x-subkit-csrf", csrf);
    headers.set("origin", ctx.baseUrl);
  }
  return browser(path, { ...init, headers });
}

function htmlValue(value: string): string {
  return value.replaceAll("&amp;", "&");
}

describe("a person's first Cockpit sign-in ends on the overview with what needs them", () => {
  test("the login page offers the API key and the key opens a browser session", async () => {
    const choice = await browser("/v1/identity/login/start");
    expect(choice.status).toBe(200);
    const link = (await choice.text()).match(/href="([^"]*provider=api-key[^"]*)"/)?.[1];
    expect(link).toBeDefined();

    const formPage = await browser(htmlValue(link ?? ""));
    expect(formPage.status).toBe(200);
    const form = (await formPage.text()).match(
      /<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/,
    );
    expect(form).not.toBeNull();
    const fields = new URLSearchParams();
    for (const tag of form?.[2]?.match(/<input[^>]*>/g) ?? []) {
      const name = tag.match(/name="([^"]+)"/)?.[1];
      if (name) fields.set(name, htmlValue(tag.match(/value="([^"]*)"/)?.[1] ?? ""));
    }
    expect([...fields.keys()].sort()).toEqual(["api_key", "login_state", "provider"]);

    fields.set("api_key", "wf_live_not-a-real-key");
    const refused = await browser(htmlValue(form?.[1] ?? ""), {
      method: "POST",
      body: fields,
      headers: { origin: ctx.baseUrl },
    });
    expect(refused.status).toBe(401);
    expect(jar.has("subkit_session")).toBe(false);

    fields.set("api_key", ctx.apiKey);
    const signedIn = await browser(htmlValue(form?.[1] ?? ""), {
      method: "POST",
      body: fields,
      headers: { origin: ctx.baseUrl },
    });
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("location")).toBe("/cockpit");
    expect(jar.has("subkit_session")).toBe(true);
  });

  test("the Cockpit session knows the person, the workspace and a write token", async () => {
    const res = await cockpit("/v1/cockpit/bootstrap");
    expect(res.status).toBe(200);
    const boot = (await res.json()) as {
      csrf_token: string;
      principal: { id: string; kind: string; provider: string; role_name: string };
      tenant: { id: string };
    };
    expect(boot.principal).toMatchObject({
      id: ctx.userId,
      kind: "user",
      provider: "browser_session",
      role_name: "admin",
    });
    expect(boot.tenant.id).toBe(ctx.tenantId);
    expect(boot.csrf_token.length).toBeGreaterThan(0);
    csrf = boot.csrf_token;
  });

  test("setup starts with recommendations and keeps the person's answers", async () => {
    const first = await cockpit("/v1/identity/me/setup");
    expect(first.status).toBe(200);
    const before = (await first.json()) as { unset: string[]; updated_at: string | null };
    expect([...before.unset].sort()).toEqual(["approver", "default_environment", "notifications"]);
    expect(before.updated_at).toBeNull();

    const answers = {
      ask_before_writing: true,
      default_environment: "prod",
      approver: { kind: "self" },
      notifications: { mode: "working_hours", from: "08:00", to: "17:00", days: [1, 2, 3, 4, 5] },
      timezone: "Europe/Berlin",
      first_job: "Lieferstatus jeden Morgen abgleichen",
      services: ["github"],
    };

    const unguarded = await browser("/v1/identity/me/setup", {
      method: "PUT",
      body: JSON.stringify(answers),
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    expect(unguarded.status).toBe(403);

    const saved = await cockpit("/v1/identity/me/setup", {
      method: "PUT",
      body: JSON.stringify(answers),
    });
    expect(saved.status).toBe(200);

    const again = await cockpit("/v1/identity/me/setup");
    const after = (await again.json()) as Record<string, unknown> & { unset: string[] };
    expect(after).toMatchObject(answers);
    expect(after.unset).toEqual([]);
    expect(after.updated_at).not.toBeNull();
  });

  test("the first scheduled job waits for the person on the overview", async () => {
    const created = await cockpit("/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Lieferstatus abgleichen",
        slug: "lieferstatus-abgleichen",
        steps: [
          {
            id: "status",
            kind: "transform",
            language: "javascript",
            expression: "return { ok: true };",
          },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const workflowId = ((await created.json()) as { id: string }).id;

    const scheduled = await cockpit("/v1/schedules", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: workflowId,
        cron: "0 7 * * 1-5",
        timezone: "Europe/Berlin",
      }),
    });
    expect(scheduled.status).toBeLessThan(300);

    const res = await cockpit("/v1/attention");
    expect(res.status).toBe(200);
    const attention = (await res.json()) as Attention;
    const view = overviewView(attention);
    expect(view.kind).toBe("items");
    if (view.kind !== "items") return;
    const item = view.items.find((entry) => entry.subject?.id === workflowId);
    expect(item).toMatchObject({
      class: "decide",
      reason: "version_awaiting_approval",
      subject: { kind: "workflow", id: workflowId, name: "Lieferstatus abgleichen" },
      trigger: { kind: "schedule" },
      approval: { version: 1, environment: "prod" },
    });
    expect(item?.actions.find((action) => action.primary)?.href).toBe(
      `/cockpit/workflows/${workflowId}#workflow-automation`,
    );
    expect(overviewSections(view, { operations: true, history: true })).toContain("attention");
    expect(attentionBadge(attention)?.count).toBe(1);
  });
});
