import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import {
  AuthProvidersEditor,
  authProvidersFromDraft,
  moveAuthProvider,
  overviewCards,
  removeAuthProvider,
  replaceAuthProvider,
  SettingEnumSelect,
  SettingNumberInput,
  SettingRow,
  SettingSecretControl,
  SettingsAttentionLine,
  SettingsFilterToggle,
  SettingsReadOnlyNotice,
  SettingsSaveBar,
  SettingsSection,
  SettingsSectionNav,
  SettingsSummary,
  settingRowNotes,
} from "@/pages/settings";
import { AiArea } from "@/pages/settings-ai";
import { CostsArea } from "@/pages/settings-costs";
import type { GuidedContext } from "@/pages/settings-guided";
import {
  changedSettingItems,
  pendingSettingDrafts,
  SETTING_GROUPS,
  type SettingItem,
  settingAppliesToShown,
  settingNavigation,
  settingsPatches,
} from "@/pages/settings-model";
import { SettingsOverview } from "@/pages/settings-overview";
import { SettingsRestartOffer } from "@/pages/settings-restart";

function render(node: ReactNode, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nContext.Provider>,
  );
}

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);
const ALL_SECTIONS = SETTING_GROUPS.flatMap((group) => group.sections);

function visibleMarkup(html: string): string {
  const marker = 'data-help-description=""';
  let out = html;
  for (let at = out.indexOf(marker); at >= 0; at = out.indexOf(marker)) {
    const start = out.lastIndexOf("<span", at);
    let depth = 0;
    let cursor = start;
    do {
      const open = out.indexOf("<span", cursor + 1);
      const close = out.indexOf("</span>", cursor + 1);
      if (open >= 0 && open < close) {
        depth += 1;
        cursor = open;
      } else {
        depth -= 1;
        cursor = close;
      }
    } while (depth >= 0);
    out = out.slice(0, start) + out.slice(cursor + "</span>".length);
  }
  return out;
}

describe("the section list", () => {
  const html = render(
    <SettingsSectionNav
      nav={settingNavigation(ALL_SECTIONS)}
      current="tokens"
      hits={null}
      drafts={new Set(["llm"])}
      onOpen={() => {}}
    />,
  );

  test("is a list of links under group headings, never a tab strip", () => {
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    for (const group of SETTING_GROUPS)
      expect(html).toContain(de(group.label).replaceAll("&", "&amp;"));
    for (const section of ALL_SECTIONS)
      expect(html).toContain(`data-testid="settings-section-link-${section}"`);
  });

  test("carries no counters", () => {
    expect(html).not.toMatch(/tabular-nums/);
  });

  test("marks the open section and a section with unsaved values", () => {
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="settings-section-link-tokens"/);
    expect(html).toContain('data-testid="settings-section-draft-llm"');
    expect(html).not.toContain('data-testid="settings-section-draft-tokens"');
  });

  test("a search keeps every section and dims those without a hit", () => {
    const searched = render(
      <SettingsSectionNav
        nav={settingNavigation(ALL_SECTIONS)}
        current={null}
        hits={new Set(["tokens"])}
        drafts={new Set()}
        onOpen={() => {}}
      />,
    );
    for (const section of ALL_SECTIONS)
      expect(searched).toContain(`data-testid="settings-section-link-${section}"`);
    expect(searched).toMatch(/data-dimmed="true"[^>]*data-testid="settings-section-link-llm"/);
    expect(searched).not.toMatch(
      /data-dimmed="true"[^>]*data-testid="settings-section-link-tokens"/,
    );
  });

  test("the page renders no tabs for its sections", () => {
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(source).not.toMatch(/@\/components\/ui\/tabs|<Tabs|TabsTrigger|role="tablist"/);
  });
});

describe("the status line", () => {
  test("is absent when nothing waits", () => {
    expect(render(<SettingsAttentionLine attention={null} onOpenLeaf={() => {}} />)).toBe("");
  });

  test("names the setting waiting for a restart and links to it", () => {
    const html = render(
      <SettingsAttentionLine
        attention={{ restart: ["auth.providers"], notActivated: false }}
        onOpenLeaf={() => {}}
      />,
    );
    expect(html).toContain(de("settings.attention.restart"));
    expect(html).toContain('href="/cockpit/settings?leaf=auth.providers"');
    expect(html).toContain(de("settings.leaf.auth.providers" as Parameters<typeof de>[0]));
    expect(html).not.toContain(de("settings.attention.notActivated"));
  });

  test("offers the restart by what the reader may do and whether a supervisor exists", () => {
    const line = (offer: "restart" | "manual" | "ask_admin") =>
      render(
        <SettingsAttentionLine
          attention={{ restart: ["server.port"], notActivated: false }}
          onOpenLeaf={() => {}}
          restartOffer={<SettingsRestartOffer offer={offer} onRestart={() => {}} />}
        />,
      );
    const button = line("restart");
    expect(button).toContain('data-testid="settings-restart-now"');
    expect(button).toContain(de("settings.restartNow.button"));
    expect(button).not.toContain(de("settings.restartNow.askAdmin"));

    const manual = line("manual");
    expect(manual).not.toContain('data-testid="settings-restart-now"');
    expect(manual).toContain('data-testid="settings-restart-manual"');
    expect(visibleMarkup(manual)).not.toContain("systemctl restart subkit-engine");
    expect(manual).toContain("systemctl restart subkit-engine");
    expect(de("settings.restartNow.manual")).toContain("systemctl restart subkit-engine");

    const ask = line("ask_admin");
    expect(ask).not.toContain('data-testid="settings-restart-now"');
    expect(ask).toContain(de("settings.restartNow.askAdmin"));
  });

  test("links a change that did not activate into the audit trail", () => {
    const html = render(
      <SettingsAttentionLine
        attention={{ restart: [], notActivated: true }}
        onOpenLeaf={() => {}}
      />,
    );
    expect(html).toContain(de("settings.attention.notActivated"));
    expect(html).toContain('href="/cockpit/audit?resource_type=settings"');
  });

  test("the page has no status tiles", () => {
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(source).not.toContain("settings-activation-status");
    expect(source).not.toMatch(/saved_revision|active_revision/);
  });
});

describe("a setting's row", () => {
  const item: SettingItem = {
    path: "tokens.monthly_budget",
    value: 150000000,
    meta: {
      source: "global",
      scope: "tenant",
      sensitive: false,
      requiresRestart: true,
      description: "Hard cap on tokens consumed per calendar month. 0 = unlimited.",
      kind: "number",
    },
  };
  const html = render(
    <SettingRow item={item} index={3} highlighted={false}>
      <input data-testid="setting-input-3" />
    </SettingRow>,
  );

  test("reads as a name, not a key", () => {
    expect(html).toContain("Monatliches Token-Kontingent");
  });

  test("keeps its restart, source and scope notes behind its (?), not as a line of its own", () => {
    expect(visibleMarkup(html)).not.toContain(de("settings.restart"));
    expect(visibleMarkup(html)).not.toContain("Gilt für");
    expect(html).toContain("Gilt für: Arbeitsbereich");
    expect(html).toContain('data-testid="setting-help-3"');
    expect(html).toContain('data-requires-restart="true"');
    expect(settingRowNotes(item, de).map((note) => note.text)).toEqual([
      de("settings.restart"),
      "Gilt für: Arbeitsbereich",
    ]);
  });

  test("has no technical disclosure, and neither the key nor the engine's English as text", () => {
    expect(html).not.toContain("<details");
    expect(html).not.toContain("setting-technical-");
    expect(html).not.toContain("Hard cap on tokens");
    expect(html).not.toContain("Wortlaut der Engine");
    expect(html).toContain('data-setting-path="tokens.monthly_budget"');
    expect(html.replace(/data-setting-path="[^"]*"/, "")).not.toContain("tokens.monthly_budget");
  });

  test("offers the key to copy only to those who may change settings", () => {
    expect(html).not.toContain('data-testid="setting-copy-key-3"');
    const writer = render(
      <SettingRow item={item} index={3} highlighted={false} canCopyKey>
        <input data-testid="setting-input-3" />
      </SettingRow>,
    );
    expect(writer).toContain('data-testid="setting-copy-key-3"');
    expect(writer).toContain(`aria-label="${de("settings.copyKey")}"`);
  });

  test("says what it applies to only where a workspace can differ", () => {
    expect(html).toContain('data-applies-to="true"');
    const globalItem = { ...item, meta: { ...item.meta, scope: "global" } };
    const global = render(
      <SettingRow item={globalItem} index={3} highlighted={false}>
        <input data-testid="setting-input-3" />
      </SettingRow>,
    );
    expect(global).not.toContain("data-applies-to");
    expect(settingRowNotes(globalItem, de).map((note) => note.id)).toEqual(["restart"]);
  });

  test("names the source behind the (?) only when it is not the plain installation value", () => {
    expect(settingRowNotes(item, de).some((note) => note.id === "source")).toBe(false);
    const tenantItem = { ...item, meta: { ...item.meta, source: "tenant" } };
    expect(settingRowNotes(tenantItem, de).find((note) => note.id === "source")?.text).toBe(
      de("settings.sourceIs", { source: "Arbeitsbereich" }),
    );
    const tenant = render(
      <SettingRow item={tenantItem} index={3} highlighted>
        <input data-testid="setting-input-3" />
      </SettingRow>,
    );
    expect(tenant).toContain('data-highlighted="true"');
  });

  test("states a structured default as changed without printing it", () => {
    const providers = {
      ...item,
      path: "llm.pricing.overrides",
      value: [{ model: "x" }],
      meta: { ...item.meta, kind: "array", default: [] },
    };
    const changed = render(
      <SettingRow item={providers} index={4} highlighted={false}>
        <input data-testid="setting-input-4" />
      </SettingRow>,
    );
    expect(changed).toContain('data-testid="setting-changed-4"');
    expect(changed).not.toContain('data-testid="setting-default-4"');
  });
});

describe("what a row says it applies to", () => {
  test("only a tenant-scoped leaf or a workspace's own value", () => {
    expect(settingAppliesToShown({ scope: "global", source: "global" })).toBe(false);
    expect(settingAppliesToShown({ scope: "global", source: "default" })).toBe(false);
    expect(settingAppliesToShown({ scope: "global", source: "env" })).toBe(false);
    expect(settingAppliesToShown({ scope: "tenant", source: "default" })).toBe(true);
    expect(settingAppliesToShown({ scope: "global", source: "tenant" })).toBe(true);
  });
});

describe("how a change is stored", () => {
  test("is answered once, behind the summary line's (?), in the plan's words", () => {
    const html = render(
      <SettingsSummary total={6} changed={1} filter="all" onFilter={() => undefined} />,
    );
    expect(html).toContain("6 Einstellungen · 1 geändert");
    expect(html).toContain('data-testid="settings-summary-help"');
    expect(de("settings.storage.body")).toContain("bis dahin läuft die vorherige Version weiter");
    const source = readFileSync(resolve(import.meta.dir, "settings.tsx"), "utf8");
    expect(source.match(/<SettingsSummary\b/g)?.length).toBe(1);
  });
});

function leafItem(
  path: string,
  value: unknown,
  meta: Partial<SettingItem["meta"]> & { kind: string },
): SettingItem {
  return {
    path,
    value,
    meta: { source: "default", scope: "global", sensitive: false, requiresRestart: false, ...meta },
  };
}

describe("a setting's control", () => {
  test("an enum is a select of the engine's values, not a text field", () => {
    const html = render(
      <SettingEnumSelect
        item={leafItem("log.level", "info", {
          kind: "enum",
          default: "info",
          enum_values: ["debug", "info"],
        })}
        index={0}
        value="info"
        disabled={false}
        onDraft={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*role="combobox"[^>]*data-testid="setting-input-0"/);
    expect(html).toContain('data-kind="enum"');
    expect(html).not.toMatch(/<input[^>]*data-testid="setting-input-0"/);
  });

  test("a number is a numeric field with its unit", () => {
    const html = render(
      <SettingNumberInput
        item={leafItem("sandbox.wall_ms", 30000, { kind: "number", default: 30000 })}
        index={1}
        value="30000"
        disabled={false}
        onDraft={() => {}}
      />,
    );
    expect(html).toMatch(/<input[^>]*type="number"[^>]*data-testid="setting-input-1"/);
    expect(html).toContain('data-testid="setting-unit-1"');
    expect(html).toContain(">ms<");
  });
});

describe("Geändert · Standard · Zurücksetzen on the row", () => {
  const budget = leafItem("tokens.monthly_budget", 500, { kind: "number", default: 0 });
  const row = (item: SettingItem, draft?: string) =>
    render(
      <SettingRow item={item} index={2} highlighted={false} draft={draft} onReset={() => {}}>
        <input data-testid="setting-input-2" />
      </SettingRow>,
    );

  test("stands when the value is not the default, with the default and the reset", () => {
    const html = row(budget);
    expect(html).toContain('data-testid="setting-changed-2"');
    expect(html).toContain(de("settings.changed"));
    expect(html).toContain("Standard: 0");
    expect(html).toContain('data-testid="setting-reset-2"');
    expect(html).toContain(de("settings.reset"));
  });

  test("is absent at the default, and once the reset drafted it", () => {
    expect(row({ ...budget, value: 0 })).not.toContain('data-testid="setting-changed-2"');
    expect(row(budget, "0")).not.toContain('data-testid="setting-changed-2"');
  });

  test("an invalid number draft is flagged on its row", () => {
    expect(row(budget, "")).toContain('data-testid="setting-invalid-2"');
  });
});

describe("a secret", () => {
  const secret = (value: unknown) =>
    leafItem("llm.api_key", value, { kind: "string", sensitive: true, default: "" });
  const control = (item: SettingItem, draft?: string) =>
    render(
      <SettingSecretControl
        item={item}
        index={4}
        draft={draft}
        disabled={false}
        onDraft={() => {}}
        onCancel={() => {}}
      />,
    );

  test("says it is stored and offers to replace it, without a field", () => {
    const html = control(secret("***"));
    expect(html).toContain(de("settings.secret.stored"));
    expect(html).toContain(de("settings.secret.replace"));
    expect(html).toContain('data-stored="true"');
    expect(html).not.toContain("<input");
    expect(html).not.toContain("***");
  });

  test("says it is not stored and offers to store one", () => {
    const html = control(secret(null));
    expect(html).toContain(de("settings.secret.notStored"));
    expect(html).toContain(de("settings.secret.store"));
    expect(html).not.toContain("data-stored");
  });

  test("the password field appears only after the click", () => {
    const html = control(secret("***"), "");
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toContain('data-testid="setting-secret-cancel-4"');
  });

  test("the hint stands once per section, behind (?), not on each secret row", () => {
    const items = [secret("***"), { ...secret(null), path: "llm.providers.openai.api_key" }];
    const heading = render(
      <SettingsSection section="llm" items={items} testId="settings-section-llm">
        <span />
      </SettingsSection>,
    );
    expect(heading.split('data-testid="settings-secret-hint-llm"').length - 1).toBe(1);
    const rowHtml = render(
      <SettingRow item={secret("***")} index={4} highlighted={false}>
        <span />
      </SettingRow>,
    );
    expect(rowHtml).not.toContain(de("settings.secretExternalOnly"));
    expect(
      render(
        <SettingsSection section="log" items={[]} testId="settings-section-log">
          <span />
        </SettingsSection>,
      ),
    ).not.toContain("settings-secret-hint");
  });
});

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
    const save = readFileSync(resolve(import.meta.dir, "settings-save.ts"), "utf8");
    expect(source).toContain("applySettingsPatches(");
    expect(save).toContain('method: "PATCH"');
    expect(source).not.toMatch(/method: "PUT"|saveWorkspaceSetting/);
    expect(source).not.toMatch(/method: "PUT"/);
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
    leaf("tokens.monthly_budget", 0, { kind: "number", default: 0 }),
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
    drafts: {},
    canWrite: true,
    pending: false,
    scope: "global",
    scopeAvailable: true,
    catalog,
    usage: null,
    publicBaseUrl: "https://subkit.test",
    setDraft() {},
    dropDraft() {},
    onScope() {},
    expertHref: () => "/settings",
    navigate() {},
    ...overrides,
  });
  const filled = (html: string) => html.match(/<button[^>]*data-variant="default"/g)?.length ?? 0;

  test("the overview is a list of area cards with one sentence each, read-only without a save bar", () => {
    const cards = overviewCards({
      facts: { items, pendingRestart: [], budgetConsumedShare: null },
      catalog,
      usage: null,
      canWrite: false,
      locale: "de",
      t: de,
      restartAction: null,
    });
    const html = render(
      <>
        <SettingsReadOnlyNotice canWrite={false} ask />
        <SettingsOverview cards={cards} onNavigate={() => {}} />
      </>,
    );
    expect(html).toContain(
      "Du darfst ansehen, nicht ändern. Für Änderungen frag einen Administrator.",
    );
    expect(html).toContain("Nutzt OpenAI mit GPT-4.1 mini. Kein Ersatz, falls OpenAI ausfällt.");
    expect(html).toContain("Kein Monatslimit. Die KI kann unbegrenzt Kosten verursachen.");
    expect(html).toContain("Nur Administratoren können hier etwas ändern.");
    expect(html).toContain('data-testid="settings-area-status-configured"');
    expect(html).toContain("Alle Einstellungen (für Fachleute)");
    expect(html).not.toContain('data-testid="settings-change-bar"');
    expect(html).not.toMatch(/role="tablist"/);
    expect(filled(html)).toBe(0);
  });

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

  test("a guided draft and a full-list draft count in the same save bar, saved once", () => {
    const drafts = {
      "llm.model": { text: "gpt-4o", scope: "tenant" as const },
      "log.level": { text: "debug", scope: "global" as const },
      "llm.api_key": { text: "", scope: "global" as const },
    };
    const pending = pendingSettingDrafts(items, drafts);
    const changed = changedSettingItems(items, pending);
    expect(changed.map((item) => item.path)).toEqual(["llm.model", "log.level"]);
    expect(
      settingsPatches({ saved_revision: 4, items }, pending, {}, tenant).map(
        (patch) => patch.scope,
      ),
    ).toEqual(["global", "tenant"]);
    const html = render(
      <>
        <AiArea ctx={ctx({ drafts: pending })} />
        <SettingsSaveBar
          count={changed.length}
          conflict={false}
          pending={false}
          invalid={false}
          onDiscard={() => {}}
          onReload={() => {}}
          onSave={() => {}}
        />
      </>,
    );
    expect(html).toContain("2 ungespeicherte Änderungen");
    expect(filled(html)).toBe(1);
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
  });

  test("the costs page offers token presets with no limit as its own option", () => {
    const html = render(<CostsArea ctx={ctx()} />);
    expect(html).toContain("Wie viele Textbausteine darf die KI pro Monat verbrauchen?");
    expect(html).toContain(">Kein Limit<");
    expect(html).toContain(">10 Mio.<");
    expect(html).toContain("Was kostet welches Modell?");
    expect(html).toContain("GPT-4.1 mini");
    expect(html).toContain("Eingebaut");
    expect(html).not.toContain("Wann möchtest du vorgewarnt werden?");
    expect(filled(html)).toBe(0);
  });
});
