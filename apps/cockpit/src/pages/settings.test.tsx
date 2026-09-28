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
import { SettingRow, SettingsAttentionLine, SettingsSectionNav } from "@/pages/settings";
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
