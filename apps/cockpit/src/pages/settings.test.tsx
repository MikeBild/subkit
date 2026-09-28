// The settings page's parts, rendered: a grouped section list and no tab
// strip, a status line only when something waits, and rows whose technical
// details stay folded away.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Locale, translate } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";
import {
  SettingEnumSelect,
  SettingNumberInput,
  SettingRow,
  SettingSecretControl,
  SettingsAttentionLine,
  SettingsFilterToggle,
  SettingsReadOnlyNotice,
  SettingsSaveBar,
  SettingsSectionHeading,
  SettingsSectionNav,
} from "@/pages/settings";
import { SETTING_GROUPS, type SettingItem, settingNavigation } from "@/pages/settings-model";

function render(node: ReactNode, locale: Locale = "de"): string {
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nContext.Provider>,
  );
}

const de = (key: Parameters<typeof translate>[1]) => translate("de", key);
const ALL_SECTIONS = SETTING_GROUPS.flatMap((group) => group.sections);

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
    // The tabs each said how many settings they held; a count is not a reason to open one.
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
    expect(html).toContain(de("settings.restart"));
  });

  test("keeps the key, source, scope and the engine's wording in collapsed technical details", () => {
    const details = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(html).toContain('<details class="mt-1 text-xs" data-testid="setting-technical-3">');
    expect(details).not.toMatch(/<details[^>]*\sopen/);
    expect(details).toContain(de("settings.technical"));
    expect(details).toContain("tokens.monthly_budget");
    expect(details).toContain(de("settings.technical.scope"));
    expect(details).toContain("Wortlaut der Engine");
    expect(details).toContain('data-testid="setting-copy-key-3"');
    // Outside the details: no key, no engine wording.
    const row = html.replace(details, "");
    expect(row).not.toContain("tokens.monthly_budget");
    expect(row).not.toContain("Wortlaut der Engine");
  });

  test("names the source on the row only when it is not the plain installation value", () => {
    expect(html).not.toContain('data-testid="setting-source-3"');
    const tenant = render(
      <SettingRow
        item={{ ...item, meta: { ...item.meta, source: "tenant" } }}
        index={3}
        highlighted
      >
        <input data-testid="setting-input-3" />
      </SettingRow>,
    );
    expect(tenant).toContain('data-testid="setting-source-3"');
    expect(tenant).toContain('data-highlighted="true"');
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

  test("the hint stands once per section, not on each secret row", () => {
    const items = [secret("***"), { ...secret(null), path: "llm.providers.openai.api_key" }];
    const heading = render(<SettingsSectionHeading section="llm" items={items} />);
    expect(heading.split(de("settings.secretExternalOnly")).length - 1).toBe(1);
    const rowHtml = render(
      <SettingRow item={secret("***")} index={4} highlighted={false}>
        <span />
      </SettingRow>,
    );
    expect(rowHtml).not.toContain(de("settings.secretExternalOnly"));
    expect(render(<SettingsSectionHeading section="log" items={[]} />)).not.toContain(
      "settings-secret-hint",
    );
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
    expect(source).toContain('method: "PATCH"');
    expect(source).not.toMatch(/method: "PUT"/);
    expect(source).not.toMatch(/setTimeout|autosave/i);
  });
});
