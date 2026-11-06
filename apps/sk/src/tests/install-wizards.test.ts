import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as prompts from "@clack/prompts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { EngineClient, type FetchLike } from "../engine-client.ts";
import * as github from "../install/github.ts";
import * as googleWorkspace from "../install/google-workspace.ts";
import * as hubspot from "../install/hubspot.ts";
import * as jira from "../install/jira.ts";
import * as salesforce from "../install/salesforce.ts";
import * as slack from "../install/slack.ts";

type Schemas = components["schemas"];

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

type Route = (seen: Seen) => { status: number; body: unknown } | undefined;

function fakeEngine(route: Route): { client: EngineClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const entry: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    const reply = route(entry) ?? { status: 404, body: { error: { code: "not_found" } } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    client: new EngineClient({ engine_url: "http://engine.test", api_key: "k", fetchImpl }),
    seen,
  };
}

const textAnswers: unknown[] = [];
const selectAnswers: unknown[] = [];
const outros: string[] = [];
const errors: string[] = [];
const textPrompts: Parameters<typeof prompts.text>[0][] = [];
const restorers: Array<{ mockRestore(): void }> = [];

beforeEach(() => {
  textAnswers.length = 0;
  selectAnswers.length = 0;
  outros.length = 0;
  errors.length = 0;
  textPrompts.length = 0;
  restorers.push(
    spyOn(prompts, "intro").mockImplementation(() => {}),
    spyOn(prompts, "cancel").mockImplementation(() => {}),
    spyOn(prompts, "outro").mockImplementation((m?: string) => {
      outros.push(String(m));
    }),
    spyOn(prompts.log, "info").mockImplementation(() => {}),
    spyOn(prompts.log, "error").mockImplementation((m: string) => {
      errors.push(m);
    }),
    spyOn(prompts, "spinner").mockImplementation(
      () =>
        ({ start() {}, stop() {}, message() {} }) as unknown as ReturnType<typeof prompts.spinner>,
    ),
    spyOn(prompts, "text").mockImplementation(async (opts) => {
      textPrompts.push(opts);
      return textAnswers.shift() as string;
    }),
    spyOn(prompts, "select").mockImplementation(async () => selectAnswers.shift() as never),
    spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    }),
  );
});

afterEach(() => {
  for (const r of restorers.splice(0)) r.mockRestore();
});

const slackWorkspace = {
  id: "00000000-0000-4000-8000-000000000001",
  tenant_id: "00000000-0000-4000-8000-000000000002",
  platform: "slack",
  workspace_id: "T0123456",
  default_channel: "C0DEFAULT",
  created_at: "2026-11-06T00:00:00.000Z",
  updated_at: "2026-11-06T00:00:00.000Z",
} satisfies Schemas["ChatWorkspace"];

const notificationChannel = {
  id: "ch-1",
  tenant_id: slackWorkspace.tenant_id,
  workspace_id: "T0123456",
  channel_id: "C0ALERTS",
  platform: "slack",
  default_severity: "info",
  rate_limit_per_minute: 60,
  circuit_state: "closed",
  circuit_open_until: null,
  consecutive_failures: 0,
  active: true,
  created_at: "2026-11-06T00:00:00.000Z",
  updated_at: "2026-11-06T00:00:00.000Z",
} satisfies Schemas["NotificationChannel"];

describe("sk install slack", () => {
  test("posts the CreateNotificationChannelBody for the installed Slack workspace", async () => {
    const { client, seen } = fakeEngine(({ method, path }) => {
      if (method === "GET" && path === "/v1/chat/workspaces")
        return {
          status: 200,
          body: {
            items: [{ ...slackWorkspace, id: "g", platform: "google_chat" }, slackWorkspace],
          },
        };
      if (method === "POST" && path === "/v1/notifications/channels")
        return { status: 201, body: notificationChannel };
      return undefined;
    });
    textAnswers.push(" C0ALERTS ");

    await slack.run(client);

    const expected = {
      platform: "slack",
      workspace_id: "T0123456",
      channel_id: "C0ALERTS",
    } satisfies Schemas["CreateNotificationChannelBody"];
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "GET /v1/chat/workspaces",
      "POST /v1/notifications/channels",
    ]);
    expect(seen[1]?.body).toEqual(expected);
    expect(textPrompts[0]?.message).toBe("Slack channel id");
    expect(textPrompts[0]?.initialValue).toBe("C0DEFAULT");
    expect(outros[0]).toContain('Channel "C0ALERTS" (ch-1) is ready');
    expect(errors).toEqual([]);
  });

  test("asks which workspace when several Slack workspaces are installed", async () => {
    const second = {
      ...slackWorkspace,
      id: "w-2",
      workspace_id: "T0SECOND",
      default_channel: null,
    };
    const { client, seen } = fakeEngine(({ method, path }) => {
      if (method === "GET" && path === "/v1/chat/workspaces")
        return { status: 200, body: { items: [slackWorkspace, second] } };
      if (method === "POST" && path === "/v1/notifications/channels")
        return { status: 201, body: { ...notificationChannel, workspace_id: "T0SECOND" } };
      return undefined;
    });
    selectAnswers.push(second);
    textAnswers.push("C0OPS");

    await slack.run(client);

    expect(seen[1]?.body).toEqual({
      platform: "slack",
      workspace_id: "T0SECOND",
      channel_id: "C0OPS",
    } satisfies Schemas["CreateNotificationChannelBody"]);
    expect(textPrompts[0]?.initialValue).toBeUndefined();
  });

  test("refuses to create a channel when no Slack workspace is installed", async () => {
    const { client, seen } = fakeEngine(({ path }) =>
      path === "/v1/chat/workspaces" ? { status: 200, body: { items: [] } } : undefined,
    );

    await expect(slack.run(client)).rejects.toThrow("process.exit(1)");

    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/chat/workspaces"]);
    expect(errors[0]).toContain("sk chat install-space slack");
  });

  test("slackChannelBody builds the engine contract shape", () => {
    expect(slack.slackChannelBody("T1", " C1 ")).toEqual({
      platform: "slack",
      workspace_id: "T1",
      channel_id: "C1",
    });
  });
});

const connectorWizards: Array<{
  slug: string;
  label: string;
  wizard: { run(client: EngineClient): Promise<void> };
}> = [
  { slug: "github", label: "GitHub", wizard: github },
  { slug: "google-workspace", label: "Google Workspace", wizard: googleWorkspace },
  { slug: "hubspot", label: "HubSpot", wizard: hubspot },
  { slug: "jira", label: "Jira", wizard: jira },
  { slug: "salesforce", label: "Salesforce", wizard: salesforce },
];

function connectorEngine(slug: string, label: string) {
  return fakeEngine(({ method, path }) => {
    if (method === "POST" && path === `/v1/connectors/from-template/${slug}`)
      return { status: 201, body: { id: "c-1", slug, display_name: label } };
    if (method === "GET" && path === "/v1/connectors/c-1")
      return { status: 200, body: { id: "c-1", slug, sign_in: { kind: "oauth" } } };
    if (method === "POST" && path === "/v1/connectors/c-1/oauth/start")
      return { status: 200, body: { authorization_url: "", state: "s" } };
    return undefined;
  });
}

describe.each(connectorWizards)("sk install $slug", ({ slug, label, wizard }) => {
  test("posts the ConnectorFromTemplateBody and starts the OAuth sign-in", async () => {
    const { client, seen } = connectorEngine(slug, label);
    textAnswers.push(` My ${label} `);

    await wizard.run(client);

    const expected = { name: `My ${label}` } satisfies Schemas["ConnectorFromTemplateBody"];
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST /v1/connectors/from-template/${slug}`,
      "GET /v1/connectors/c-1",
      "POST /v1/connectors/c-1/oauth/start",
    ]);
    expect(seen[0]?.body).toEqual(expected);
    expect(textPrompts[0]).toMatchObject({ message: "Connector display name", placeholder: label });
    expect(outros[0]).toContain(`${label} connector "${label}" is connected!`);
    expect(errors).toEqual([]);
  });

  test("omits an empty name so the engine falls back to the template name", async () => {
    const { client, seen } = connectorEngine(slug, label);
    textAnswers.push(undefined);

    await wizard.run(client);

    expect(seen[0]?.body).toEqual({} satisfies Schemas["ConnectorFromTemplateBody"]);
  });
});
