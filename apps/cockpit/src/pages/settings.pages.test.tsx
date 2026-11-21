import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, visibleMarkup } from "@/features/settings/model/settings-fixtures";
import {
  changedSettings,
  pendingSettingDrafts,
  type SettingItem,
  settingDraftTexts,
  settingsPatches,
} from "@/features/settings/model/settings-model";
import { AiArea } from "@/features/settings/ui/settings-ai";
import { SettingsAreaFrame, UsageNote } from "@/features/settings/ui/settings-frame";
import type { GuidedContext } from "@/features/settings/ui/settings-guided";
import {
  AuthProvidersEditor,
  authProvidersFromDraft,
  moveAuthProvider,
  removeAuthProvider,
  replaceAuthProvider,
  SettingsFilterToggle,
  SettingsReadOnlyNotice,
  SettingsSaveBar,
} from "@/features/settings/ui/settings-rows";
import { translate } from "@/lib/i18n";

describe("the page's frame", () => {
  test("the filter offers Alle and Geändert", () => {
    const html = render(<SettingsFilterToggle filter="changed" onChange={() => {}} />);
    expect(html).toContain('data-testid="settings-filter-all"');
    expect(html).toMatch(
      /aria-checked="true"[^>]*data-testid="settings-filter-changed"|data-state="on"[^>]*data-testid="settings-filter-changed"/,
    );
    expect(html).toContain(">Geändert<");
  });

  test("a reader without settings:write is told so", () => {
    expect(render(<SettingsReadOnlyNotice canWrite={false} />)).toContain(
      "Du darfst ansehen, nicht ändern.",
    );
    expect(render(<SettingsReadOnlyNotice canWrite />)).toBe("");
  });

  test("the save bar counts every draft and saves them at once", () => {
    const html = render(
      <SettingsSaveBar
        count={3}
        conflict={false}
        pending={false}
        invalid={false}
        onDiscard={() => {}}
        onReload={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("3 ungespeicherte Änderungen");
    expect(html).toContain(">Verwerfen<");
    expect(html).toContain(">Speichern<");
    expect(html).not.toContain('data-testid="settings-conflict"');
  });

  test("after a conflict the bar asks for a reload and keeps the drafts", () => {
    const html = render(
      <SettingsSaveBar
        count={2}
        conflict
        pending={false}
        invalid={false}
        onDiscard={() => {}}
        onReload={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain(
      "Inzwischen hat jemand gespeichert – neu laden, deine Entwürfe bleiben.",
    );
    expect(html).toContain('data-testid="settings-conflict-reload"');
    expect(html).not.toContain('data-testid="settings-save"');
    expect(html).toContain("2 ungespeicherte Änderungen");
  });

  test("the page saves once, with PATCH, and no longer per field", () => {
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    const save = readFileSync(
      resolve(import.meta.dir, "../features/settings/api/settings-save.ts"),
      "utf8",
    );
    expect(source).toContain("applySettingsPatch(");
    expect(save).toContain('apiCall("patch", "/v1/settings"');
    expect(source).not.toMatch(/method: "PUT"|apiCall\("put"|saveSetting\(/);
    expect(source).not.toMatch(/method: "PUT"|apiCall\("put"/);
    expect(source).not.toMatch(/setTimeout|autosave/i);
  });
});

describe("the sign-in provider editor", () => {
  const stored = [
    { protocol: "api_key", id: "api-key", label: "SubKit API key" },
    {
      protocol: "oidc",
      id: "workforce",
      label: "Workforce",
      issuer_url: "https://issuer.example.com",
      client_id: "cockpit",
      scopes: "openid profile email",
      tenant_slug: "default",
      link_by_email: true,
      product_id: "helpdesk",
    },
    {
      protocol: "oidc_bearer",
      id: "helpdesk-users",
      label: "Helpdesk users",
      issuer_url: "https://auth.example.com",
      jwks_uri: "https://auth.example.com/jwks.json",
      audience: "helpdesk-api",
      algorithms: ["ES256", "RS256"],
      product_id: "helpdesk",
      tenant_slug: "default",
      required_claims: [{ path: "app_metadata.role", equals: "member" }],
      reject_anonymous: true,
      clock_tolerance_s: 30,
    },
    { protocol: "saml", id: "partner", label: "Partner", metadata_url: "https://idp.example.com" },
  ];
  const raw = JSON.stringify(stored);

  test("keeps every provider it does not edit, byte for byte, when another one changes", () => {
    const providers = authProvidersFromDraft(raw, []);
    expect(providers).toHaveLength(stored.length);
    const apiKey = providers[0]!;
    const edited = replaceAuthProvider(providers, 0, { ...apiKey, label: "Team key" });
    const expected = structuredClone(stored);
    expected[0]!.label = "Team key";
    expect(JSON.stringify(edited)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(edited.slice(1))).toBe(JSON.stringify(stored.slice(1)));
  });

  test("keeps the extra fields of an edited OIDC provider", () => {
    const providers = authProvidersFromDraft(raw, []);
    const oidc = providers[1]!;
    const edited = replaceAuthProvider(providers, 1, { ...oidc, label: "Staff" });
    expect(edited[1]).toEqual({ ...stored[1]!, label: "Staff" });
  });

  test("reorders and removes without losing a managed or unknown provider", () => {
    const providers = authProvidersFromDraft(raw, []);
    const moved = moveAuthProvider(providers, 1, 1);
    expect(moved.map((provider) => provider.id)).toEqual([
      "api-key",
      "helpdesk-users",
      "workforce",
      "partner",
    ]);
    const removed = removeAuthProvider(moved, 2);
    expect(JSON.stringify(removed)).toBe(JSON.stringify([stored[0], stored[2], stored[3]]));
  });

  test("reads the stored value when the draft is not valid JSON", () => {
    expect(JSON.stringify(authProvidersFromDraft("{", stored))).toBe(raw);
  });

  test("shows an app sign-in and an unknown protocol read-only, with where they are managed", () => {
    const html = render(
      <AuthProvidersEditor
        value={authProvidersFromDraft(raw, [])}
        publicBaseUrl="https://subkit.example.com"
        disabled={false}
        onChange={() => {}}
      />,
      "en",
    );
    expect(html).toContain('data-testid="settings-auth-provider-2-facts"');
    expect(html).toContain("auth.example.com");
    expect(html).toContain("helpdesk-api");
    expect(html).toContain("helpdesk");
    expect(html).toContain(translate("en", "settings.auth.managedInApps").replace("&", "&amp;"));
    expect(html).not.toContain('data-testid="settings-auth-provider-2-issuer-url"');
    expect(html).toContain('data-testid="settings-auth-provider-3-facts"');
    expect(html).toContain("saml");
    expect(html).toContain(translate("en", "settings.auth.managedElsewhere"));
    expect(html).toContain('data-testid="settings-auth-provider-2-remove"');
    expect(html).toContain('data-testid="settings-auth-provider-1-issuer-url"');
  });
});

describe("the guided settings pages", () => {
  const tenant = "5870ae6d-e542-48ca-bbcc-108b5ae73f5f";
  const leaf = (
    path: string,
    value: unknown,
    meta: Partial<SettingItem["meta"]> & { kind: string },
  ): SettingItem => ({
    path,
    value,
    meta: {
      source: "default",
      scope: "tenant",
      sensitive: false,
      requiresRestart: false,
      ...meta,
    },
  });
  const items: SettingItem[] = [
    leaf("llm.provider", "openai", {
      kind: "enum",
      default: "mock",
      enum_values: ["mock", "anthropic", "openai", "gemini"],
    }),
    leaf("llm.model", "gpt-4.1-mini", { kind: "string", default: "" }),
    leaf("llm.fallback_provider", null, {
      kind: "enum",
      default: null,
      enum_values: ["mock", "anthropic", "openai", "gemini"],
    }),
    leaf("llm.fallback_model", "", { kind: "string", default: "" }),
    leaf("llm.api_key", "", { kind: "string", sensitive: true, default: "" }),
    leaf("llm.providers.openai.api_key", "***", { kind: "string", sensitive: true, default: "" }),
    leaf("log.level", "info", { kind: "enum", scope: "global", default: "info" }),
    leaf("connectors.mcp.tools_list_max_pages", 0, { kind: "number", default: 0 }),
  ];
  const catalog = {
    currency: "USD",
    models: [
      {
        provider: "openai" as const,
        model: "gpt-4.1-mini",
        display_name: "GPT-4.1 mini",
        input_per_mtok: 0.4,
        output_per_mtok: 1.6,
        price_source: "catalog" as const,
        badges: { recommended: true, economical: true, capable: false },
      },
    ],
  };
  const ctx = (overrides: Partial<GuidedContext> = {}): GuidedContext => ({
    items,
    globalItems: items,
    tenantItems: null,
    effectiveItems: items,
    drafts: {},
    canWrite: true,
    pending: false,
    scope: "global",
    scopeAvailable: true,
    catalog,
    publicBaseUrl: "https://subkit.test",
    setDraft() {},
    dropDraft() {},
    onScope() {},
    navigate() {},
    ...overrides,
  });
  const filled = (html: string) => html.match(/<button[^>]*data-variant="default"/g)?.length ?? 0;

  test("the assistant page asks in plain words and keeps technical keys out", () => {
    const html = render(<AiArea ctx={ctx()} />);
    expect(html).toContain("Welchen KI-Anbieter nutzt du?");
    expect(html).toContain("Welches Modell soll OpenAI verwenden?");
    expect(html).toContain("Was passiert, falls OpenAI ausfällt?");
    expect(html).toContain("Ist der Zugangsschlüssel für OpenAI hinterlegt?");
    expect(html).toContain("Schlüssel ersetzen");
    expect(html).toContain("Testmodus ohne echte KI");
    expect(html).toContain('data-testid="settings-scope-toggle"');
    expect(visibleMarkup(html)).not.toMatch(/llm\.provider|llm\.model|\bTokens?\b(?!\))/);
    expect(filled(html)).toBe(0);
  });

  test("a reader without the right sees disabled controls and the stored key without replace", () => {
    const html = render(<AiArea ctx={ctx({ canWrite: false, scopeAvailable: false })} />);
    expect(html).toContain("Hinterlegt (nur Administratoren können ihn ersetzen)");
    expect(html).toMatch(
      /data-testid="settings-ai-provider-openai"[^>]*disabled=""|disabled=""[^>]*data-testid="settings-ai-provider-openai"/,
    );
    expect(html).not.toContain('data-testid="settings-scope-toggle"');
  });

  test("a guided draft and a full-list draft count in the same save bar, one scope per save", () => {
    const drafts = {
      global: { "log.level": "debug", "llm.api_key": "" },
      tenant: { "llm.model": "gpt-4o" },
    };
    const pending = pendingSettingDrafts(items, drafts);
    const changed = changedSettings(items, pending);
    expect(changed.map((entry) => `${entry.scope}:${entry.item.path}`)).toEqual([
      "global:log.level",
      "tenant:llm.model",
    ]);
    expect(
      settingsPatches(
        { saved_revision: 4, items },
        pending,
        { global: {}, tenant: {} },
        tenant,
      ).map((patch) => patch.scope),
    ).toEqual(["global", "tenant"]);
    const html = render(
      <>
        <AiArea ctx={ctx({ drafts: settingDraftTexts(drafts, items, "global") })} />
        <SettingsSaveBar
          count={changed.length}
          conflict={false}
          pending={false}
          invalid={false}
          firstOf={1}
          onDiscard={() => {}}
          onReload={() => {}}
          onSave={() => {}}
        />
      </>,
    );
    expect(html).toContain(
      "Zuerst wird 1 Änderung für alle Arbeitsbereiche gespeichert, die für diesen Arbeitsbereich danach in einem zweiten Schritt.",
    );
    expect(html).toContain(">Erst diese Änderungen speichern<");
    expect(filled(html)).toBe(1);
  });

  test("a value the engine rejects shows its reason in the save bar and keeps the drafts", () => {
    const html = render(
      <SettingsSaveBar
        count={1}
        conflict={false}
        failed
        reason="llm.model 'claude-sonnet-4-6' would be sent to the openai provider."
        pending={false}
        invalid={false}
        onDiscard={() => {}}
        onReload={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain(
      "Nicht gespeichert: llm.model &#x27;claude-sonnet-4-6&#x27; would be sent to the openai provider. Deine Änderungen sind noch da.",
    );
    expect(html).toMatch(/role="alert" data-testid="settings-save-failed"/);
  });

  test("an entry that needs correcting heads the save bar and blocks saving", () => {
    const html = render(
      <SettingsSaveBar
        count={1}
        conflict={false}
        pending={false}
        invalid={false}
        invalidCount={1}
        onDiscard={() => {}}
        onReload={() => {}}
        onSave={() => {}}
      />,
    );
    expect(html).toContain("1 Angabe muss noch korrigiert werden.");
    expect(html).toMatch(
      /disabled=""[^>]*data-testid="settings-save"|data-testid="settings-save"[^>]*disabled=""/,
    );
  });

  test("drafts from the full list are always for all workspaces", () => {
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(source).toContain('onDraft={(path, text) => setDraft(path, text, "global")}');
    expect(source).toContain("drafts={draftState.drafts.global}");
  });

  test("a save keeps its drafts until the reloaded settings and usage are in", () => {
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    const reloaded = source.indexOf("await Promise.all([");
    expect(reloaded).toBeGreaterThan(0);
    expect(source.indexOf("draftState.clear(saved)")).toBeGreaterThan(reloaded);
    expect(source).toContain('client.invalidateQueries({ queryKey: ["usage-status"] })');
    expect(source).toContain("settleSettings(");
  });

  test("the area list is a column from 760px and a select below, never a sideways row", () => {
    const html = render(
      <SettingsAreaFrame
        area="ai"
        areas={["profile", "workspace", "ai", "notifications"]}
        expert
        drafted={new Set()}
        attention={new Set()}
        onNavigate={() => {}}
      >
        <AiArea ctx={ctx()} />
      </SettingsAreaFrame>,
    );
    expect(html).toContain(
      'class="hidden shrink-0 flex-col gap-4 @min-[760px]/settings:flex @min-[760px]/settings:w-56" data-testid="settings-area-nav"',
    );
    expect(html).toContain(
      'class="@min-[760px]/settings:hidden" data-testid="settings-area-select"',
    );
    const areaNav = html.slice(0, html.indexOf('data-testid="settings-area-ai"'));
    expect(areaNav).not.toContain("overflow-x-auto");
    expect(html).not.toContain('data-testid="settings-all-areas"');
    expect(html).toContain('data-testid="settings-area-nav-expert"');
    expect(html).toContain(">KI-Assistent<");
    const ai = render(<AiArea ctx={ctx()} />);
    expect(ai).toMatch(/class="grid gap-3 sm:grid-cols-2" data-testid="settings-ai-providers"/);
  });

  test("rows read the drafts as typed, so an opened key field stays open", () => {
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(source).toContain("drafts: draftState.texts(viewItems, scope)");
    expect(source).not.toMatch(/drafts: (pending|pendingDrafts)\b/);
  });

  test("budget, prices and currency have no area of their own; a note points to the usage page", () => {
    const html = render(<UsageNote />);
    expect(html).toContain(
      "Monatskontingent, Modellpreise und Währung änderst du auf der Seite „Nutzung“.",
    );
    expect(html).toContain('href="/cockpit/usage" class=');
  });
});
