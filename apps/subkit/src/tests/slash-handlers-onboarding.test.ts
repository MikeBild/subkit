import { describe, expect, test } from "bun:test";
import type { PaneSpec, SlashHandlerContext } from "../repl/slash/handler.ts";
import {
  dispatchOnboardingSlash,
  onboardingCredential,
} from "../repl/slash/handlers/onboarding.ts";

const noHints = { credential_hints: [], auth_options: [] };
const keyHeader = {
  auth_options: [],
  credential_hints: [
    {
      field: "value",
      label: "API key",
      placeholder: "",
      doc_url: null,
      secret: true,
      header_name: "x-api-key",
    },
  ],
};

describe("onboardingCredential", () => {
  test("stores a bearer token and a signed_jwt key under their own modes", () => {
    expect(onboardingCredential("c1", "bearer", noHints, " t-1 ")).toEqual({
      ok: true,
      body: { mode: "bearer", token: "t-1" },
    });
    expect(onboardingCredential("c1", "signed_jwt", noHints, "pem")).toEqual({
      ok: true,
      body: { mode: "signed_jwt", private_key: "pem" },
    });
  });

  test("a header key takes its name from the template's credential hint", () => {
    expect(onboardingCredential("c1", "header", keyHeader, "k-1")).toEqual({
      ok: true,
      body: { mode: "header", headers: { "x-api-key": "k-1" } },
    });
  });

  test("a header or query key takes its name from the template's auth option first", () => {
    const option = (auth_type: "header" | "query", param_name: string) => ({
      credential_hints: [],
      auth_options: [{ auth_type, label: "Key", description: "Key", param_name }],
    });
    expect(
      onboardingCredential("c1", "header", option("header", "X-Shopify-Access-Token"), "k-1"),
    ).toEqual({ ok: true, body: { mode: "header", headers: { "X-Shopify-Access-Token": "k-1" } } });
    expect(onboardingCredential("c1", "query", option("query", "token"), "k-2")).toEqual({
      ok: true,
      body: { mode: "query", query: { token: "k-2" } },
    });
    expect(
      onboardingCredential(
        "c1",
        "header",
        { ...keyHeader, auth_options: option("header", "apikey").auth_options },
        "k-3",
      ),
    ).toEqual({ ok: true, body: { mode: "header", headers: { apikey: "k-3" } } });
  });

  test("a header or query key without a named field points to subkit vault attach", () => {
    const header = onboardingCredential("c1", "header", noHints, "k-1");
    expect(header.ok).toBe(false);
    expect(header.ok ? "" : header.reason).toContain(
      "`subkit vault attach c1 --mode header --header <name>` and the value on stdin",
    );
    const query = onboardingCredential("c1", "query", undefined, "k-1");
    expect(query.ok ? "" : query.reason).toContain(
      "`subkit vault attach c1 --mode query --query <name>` and the value on stdin",
    );
  });

  test("two-value modes and account sign-in are refused with the command that does them", () => {
    const basic = onboardingCredential("c1", "basic", noHints, "user:pass");
    expect(basic.ok ? "" : basic.reason).toContain("`subkit vault attach c1 --mode basic`");
    const oauth = onboardingCredential("c1", "oauth2", noHints, "token");
    expect(oauth.ok ? "" : oauth.reason).toContain("`subkit auth --connector-id c1`");
  });

  test("an empty secret or a connector without sign-in stores nothing", () => {
    expect(onboardingCredential("c1", "bearer", noHints, "  ")).toEqual({ ok: true, body: null });
    expect(onboardingCredential("c1", "none", noHints, "x")).toEqual({ ok: true, body: null });
  });
});

describe("/onboard wizard", () => {
  test("stores the typed key and reuses the connector when the probe is retried", async () => {
    const created: string[] = [];
    const credentials: Array<{ id: string; body: unknown }> = [];
    let tests = 0;
    let pane: PaneSpec | null = null;
    const client = {
      listConnectorTemplates: async () => ({
        items: [{ slug: "anthropic", name: "Anthropic", auth_type: "header", ...keyHeader }],
      }),
      createConnectorFromTemplate: async (slug: string) => {
        created.push(slug);
        return { id: "conn-1", auth_type: "header" };
      },
      createCredential: async (id: string, body: unknown) => {
        credentials.push({ id, body });
        return { id: "cred-1" };
      },
      testConnector: async () => {
        tests += 1;
        return tests === 1 ? { ok: false, detail: "401 unauthorized" } : { ok: true };
      },
    };
    const ctx = {
      client: client as unknown as SlashHandlerContext["client"],
      profile: {} as SlashHandlerContext["profile"],
      session: {} as SlashHandlerContext["session"],
      setConversationId: () => {},
      allowedPermissions: [],
      openPane: (spec: PaneSpec) => {
        pane = spec;
      },
    } satisfies SlashHandlerContext;

    expect(await dispatchOnboardingSlash("onboard", ctx)).toBeNull();
    const wizard = pane as PaneSpec | null;
    if (wizard?.kind !== "onboarding-wizard") throw new Error("no onboarding wizard opened");
    const template = wizard.templates[0];
    if (!template) throw new Error("no template offered");

    expect(await wizard.onProbe(template, "wrong-key")).toEqual({
      ok: false,
      reason: "401 unauthorized",
    });
    expect(await wizard.onProbe(template, "right-key")).toEqual({ ok: true });
    expect(await wizard.onSave(template, "right-key")).toEqual({
      ok: true,
      connector_id: "conn-1",
    });
    expect(created).toEqual(["anthropic"]);
    expect(credentials).toEqual([
      { id: "conn-1", body: { mode: "header", headers: { "x-api-key": "wrong-key" } } },
      { id: "conn-1", body: { mode: "header", headers: { "x-api-key": "right-key" } } },
    ]);
  });

  test("a key the wizard cannot store fails the probe and blocks the save", async () => {
    let pane: PaneSpec | null = null;
    let tested = false;
    const client = {
      listConnectorTemplates: async () => ({
        items: [{ slug: "browserless", name: "Browserless", auth_type: "query", ...noHints }],
      }),
      createConnectorFromTemplate: async () => ({ id: "conn-2", auth_type: "query" }),
      createCredential: async () => {
        throw new Error("must not store");
      },
      testConnector: async () => {
        tested = true;
        return { ok: true };
      },
    };
    const ctx = {
      client: client as unknown as SlashHandlerContext["client"],
      profile: {} as SlashHandlerContext["profile"],
      session: {} as SlashHandlerContext["session"],
      setConversationId: () => {},
      allowedPermissions: [],
      openPane: (spec: PaneSpec) => {
        pane = spec;
      },
    } satisfies SlashHandlerContext;
    await dispatchOnboardingSlash("onboard", ctx);
    const wizard = pane as PaneSpec | null;
    if (wizard?.kind !== "onboarding-wizard") throw new Error("no onboarding wizard opened");
    const template = wizard.templates[0];
    if (!template) throw new Error("no template offered");
    const probe = await wizard.onProbe(template, "token-1");
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("subkit vault attach conn-2 --mode query");
    expect(tested).toBe(false);
    expect(await wizard.onSave(template, "token-1")).toEqual({
      ok: false,
      reason: "probe must succeed before save",
    });
  });
});
