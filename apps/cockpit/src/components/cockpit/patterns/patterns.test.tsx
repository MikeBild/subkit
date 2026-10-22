import { describe, expect, test } from "bun:test";
import { Badge } from "@/components/ui/badge";
import { translate } from "@/lib/i18n";
import { ActionMenu } from "./action-menu";
import { ChatCard } from "./chat-card";
import { CodeBlock } from "./code-block";
import { confirmTitle } from "./confirm-dialog";
import { CopyField } from "./copy-field";
import { DataState } from "./data-state";
import { FactList } from "./fact-list";
import { FilterBar } from "./filter-bar";
import { dialogWidthClass } from "./form-dialog";
import { Page, READING_COLUMN } from "./page";
import { PageHeader } from "./page-header";
import { searchWithTab, tabFromSearch } from "./page-tabs";
import { sheetWidthClass } from "./record-sheet";
import { activeRouteTab } from "./route-tabs";
import { CollapsibleSection, Section } from "./section";
import { SegmentedControl } from "./segmented-control";
import { StatusBadge, statusTone } from "./status-badge";
import { StatusStrip } from "./status-strip";
import { SummaryLine } from "./summary-line";
import { render, renderInRouter } from "./test-utils";

const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;

describe("P1 Page", () => {
  test("lists and records share one width and start at the page gutter, left-aligned", () => {
    for (const [kind, width] of [
      ["list", "max-w-[1280px]"],
      ["settings", "max-w-[1440px]"],
      ["detail", "max-w-[1280px]"],
    ] as const) {
      const html = render(
        <Page kind={kind} scroll="page" testId="p" header={<div>head</div>}>
          body
        </Page>,
      );
      expect(html).toContain(`data-page-kind="${kind}"`);
      expect(count(html, new RegExp(width.replace(/[[\]]/g, "\\$&"), "g"))).toBe(2);
      expect(count(html, /mx-auto/g)).toBe(0);
      expect(html).toContain("px-4 sm:px-6");
      expect(html).toContain('data-family-slot="scroll-region"');
    }
    expect(READING_COLUMN).not.toContain("mx-auto");
  });

  test("a workspace spans the full width without a gutter", () => {
    const html = render(
      <Page kind="workspace" scroll="page" testId="p" header={<div>head</div>}>
        body
      </Page>,
    );
    expect(html).toContain("w-full");
    expect(html).not.toContain("px-4");
    expect(html).not.toContain("mx-auto");
  });

  test("a body that owns its scroll gets no scroll region; the toolbar gets the filters slot", () => {
    const html = render(
      <Page kind="list" scroll="content" testId="p" header={null} toolbar={<span>f</span>}>
        body
      </Page>,
    );
    expect(html).not.toContain('data-family-slot="scroll-region"');
    expect(html).toContain('data-family-slot="filters"');
    expect(html).toContain('data-testid="p"');
  });
});

describe("P2 PageHeader", () => {
  test("renders the one h1, its actions right, and no toggle it does not own", async () => {
    const html = await renderInRouter(
      <PageHeader
        title="Workflows"
        badge={<span data-x="badge" />}
        purpose="Wozu"
        action={
          <button type="button" data-testid="x">
            Ausführen
          </button>
        }
        menu={<span data-x="menu" />}
      />,
    );
    expect(count(html, /<h1/g)).toBe(1);
    expect(html).toContain('data-slot="page-actions"');
    expect(html).toContain('data-slot="page-purpose"');
    expect(html).not.toContain("sidebar-trigger");
    expect(html).not.toContain('data-testid="detail-back"');
  });

  test("a record's page carries the back link to its list, never its own name", async () => {
    const html = await renderInRouter(
      <PageHeader title="upraft-auth-notify" back={{ to: "/workflows", label: "Workflows" }} />,
    );
    expect(html).toContain('data-testid="detail-back"');
    expect(html).toContain('data-slot="page-back"');
    expect(html).toMatch(/href="\/cockpit\/workflows"/);
    expect(count(html, />upraft-auth-notify</g)).toBe(1);
  });

  test("an eyebrow names the area above the h1 and is no heading itself", async () => {
    const html = await renderInRouter(<PageHeader eyebrow="Wissen" title="Quellen" />);
    expect(html).toContain('data-slot="page-eyebrow"');
    expect(html.indexOf("Wissen")).toBeLessThan(html.indexOf("<h1"));
    expect(count(html, /<h[1-6]/g)).toBe(1);
  });
});

describe("P3 StatusStrip", () => {
  test("one dot, one line, one action, and the tone it was given", () => {
    const html = render(
      <StatusStrip
        tone="warn"
        line="Wartet auf Freigabe"
        action={
          <button type="button" data-testid="x">
            Freigeben
          </button>
        }
        testId="strip"
      />,
    );
    expect(html).toContain('data-slot="status-strip"');
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain("Freigeben");
  });
});

describe("P4 PageTabs", () => {
  test("an address names its tab; a missing or unknown one is the default", () => {
    const values = ["a", "b", "c"];
    expect(tabFromSearch("?tab=b", "tab", values, "a")).toBe("b");
    expect(tabFromSearch("?tab=zzz", "tab", values, "a")).toBe("a");
    expect(tabFromSearch("", "tab", values, "a")).toBe("a");
    expect(tabFromSearch("?section=c", "section", values, "a")).toBe("c");
  });

  test("choosing a tab keeps every other parameter and drops the default", () => {
    expect(searchWithTab("?connected=1e5&tab=a", "tab", "b", "a")).toBe("?connected=1e5&tab=b");
    expect(searchWithTab("?connected=1e5&tab=b", "tab", "a", "a")).toBe("?connected=1e5");
    expect(searchWithTab("", "section", "a", "a")).toBe("");
    expect(searchWithTab("?tab=a&step=2&grant=g&tool=x&version=v&q=k", "tab", "b", "a")).toBe(
      "?tab=b&q=k",
    );
  });

  test("a tab that is a page of its own is active on its list and on its records", () => {
    const tabs = [
      { to: "/knowledge", label: "Quellen" },
      { to: "/skills", label: "Skills" },
    ];
    expect(activeRouteTab("/cockpit/skills", tabs)).toBe("/skills");
    expect(activeRouteTab("/cockpit/knowledge/abc", tabs)).toBe("/knowledge");
    expect(activeRouteTab("/cockpit/files", tabs)).toBeNull();
  });
});

describe("P5 SummaryLine", () => {
  test("one sentence and the control on the right", () => {
    const html = render(<SummaryLine text="3 Läufe" aside={<span data-x="seg" />} />);
    expect(html).toContain('data-slot="summary-line"');
    expect(html).toContain("3 Läufe");
    expect(html).toContain('data-x="seg"');
  });
});

describe("P7 FilterBar", () => {
  test("the wide panel exposes search, every filter, grouping context and apply", () => {
    const select = (label: string) => ({
      value: "all",
      onChange() {},
      label,
      options: [{ value: "all", label: "Alle" }],
    });
    const html = render(
      <FilterBar
        presentation="panel"
        search={{ value: "", onChange() {}, placeholder: "Suchen", testId: "search" }}
        selects={[select("A"), select("B"), select("C")]}
        segmented={<span>Zeitraum</span>}
      />,
    );
    expect(html).toContain('data-testid="search-panel"');
    expect(count(html, /role="combobox"/g)).toBe(3);
    expect(html).toContain("Zeitraum");
    expect(html).toContain('data-testid="filter-bar-panel-apply"');
  });
});

describe("P8 RecordSheet", () => {
  test("two widths and no others, stated for the side the sheet opens on", () => {
    expect(sheetWidthClass("default")).toBe("data-[side=right]:sm:max-w-xl");
    expect(sheetWidthClass("wide")).toBe("data-[side=right]:sm:max-w-5xl");
  });
});

describe("P9 FactList", () => {
  test("a two-column definition list", () => {
    const html = render(
      <FactList
        items={[
          { label: "Umgebung", value: "Produktion" },
          { label: "Dauer", value: "bis auf Widerruf" },
        ]}
      />,
    );
    expect(html).toContain("<dl");
    expect(count(html, /<dt/g)).toBe(2);
    expect(count(html, /<dd/g)).toBe(2);
  });
});

describe("P10 Section", () => {
  test("the label is small and muted, never an h2 look", () => {
    const html = render(<Section label="Eingabe">x</Section>);
    expect(html).toContain('class="text-xs font-medium text-muted-foreground"');
    expect(render(<Section>x</Section>)).not.toContain("<h2");
  });

  test("a collapsed section names itself and its count", () => {
    const html = render(
      <CollapsibleSection label="Technische Angaben" count={4}>
        x
      </CollapsibleSection>,
    );
    expect(html).toContain("Technische Angaben");
    expect(html).toMatch(/text-muted-foreground tabular-nums">4<\/span>/);
    expect(html).not.toContain("(4)");
  });
});

describe("P11 StatusBadge", () => {
  test("a state is a dot and its word", () => {
    const html = render(<StatusBadge state="failed" />);
    expect(html).toContain('data-slot="status-dot"');
    expect(html).toContain(translate("de", "status.failed"));
    expect(html).toContain('data-tone="error"');
    expect(html).toContain("min-w-0 max-w-full");
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain(`title="${translate("de", "status.failed")}"`);
    expect(html).toContain(`aria-label="${translate("de", "status.failed")}"`);
  });

  test("a plain badge draws no dot", () => {
    expect(render(<Badge>Kategorie</Badge>)).not.toContain("status-dot");
  });

  test("a long status is bounded while its complete text stays accessible", () => {
    const label = "Zugangsdaten abgelehnt und erneute Anmeldung erforderlich";
    const html = render(<StatusBadge state="rejected" label={label} />);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain("min-w-0 max-w-full");
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain(`>${label}</span>`);
  });

  test("tones", () => {
    expect(statusTone("succeeded")).toBe("ok");
    expect(statusTone("RUNNING")).toBe("warn");
    expect(statusTone("needs_reauth")).toBe("error");
    expect(statusTone("denied")).toBe("error");
    expect(statusTone("draft")).toBe("neutral");
  });
});

describe("P12 DataState", () => {
  test("loading is three rows a table row high", () => {
    const html = render(<DataState state="loading" />);
    expect(count(html, /data-slot="data-state-row"/g)).toBe(3);
    expect(html).toContain("h-11");
  });

  test("empty is one line and one action", () => {
    const html = render(
      <DataState
        state="empty"
        line="Noch keine Workflows."
        action={
          <button type="button" data-testid="x">
            Workflow erstellen
          </button>
        }
      />,
    );
    expect(html).toContain("Noch keine Workflows.");
    expect(count(html, /<button/g)).toBe(1);
    expect(html).not.toContain("text-center");
  });

  test("an error offers to try again", () => {
    const html = render(
      <DataState state="error" line="Workflows konnten nicht geladen werden." onRetry={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Erneut versuchen");
  });
});

describe("P13 ConfirmDialog", () => {
  const t =
    (locale: "de" | "en") =>
    (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
      translate(locale, key, values);

  test("the title is the object and the verb, the verb lower-cased in German", () => {
    expect(confirmTitle(t("de"), "de", "Freigabe v4", "Widerrufen")).toBe(
      "Freigabe v4 widerrufen?",
    );
    expect(confirmTitle(t("en"), "en", "approval v4", "Revoke")).toBe("Revoke approval v4?");
  });
});

describe("P14 FormDialog", () => {
  test("two widths", () => {
    expect(dialogWidthClass("default")).toBe("sm:max-w-lg");
    expect(dialogWidthClass("wide")).toBe("sm:max-w-xl");
  });
});

describe("P15 CopyField and CodeBlock", () => {
  test("a value in mono with a copy button", () => {
    const html = render(<CopyField value="https://sk.example.com/mcp" label="MCP" testId="mcp" />);
    expect(html).toContain('value="https://sk.example.com/mcp"');
    expect(html).toContain("readOnly");
    expect(html).toContain('data-testid="mcp-copy"');
    expect(html).toContain('data-testid="mcp-field"');
    expect(html).toMatch(/<input[^>]*data-testid="mcp"/);
  });

  test("code is the one pre", () => {
    const html = render(<CodeBlock code={'{"a":1}'} lang="json" testId="payload" />);
    expect(count(html, /<pre/g)).toBe(1);
    expect(html).toContain('data-testid="payload-copy"');
  });
});

describe("P16 ActionMenu", () => {
  test("one item is a named outline button, not a menu", () => {
    const html = render(<ActionMenu items={[{ label: "Im Chat fragen", onSelect() {} }]} />);
    expect(html).toContain("Im Chat fragen");
    expect(html).toContain('data-variant="outline"');
    expect(html).not.toContain("aria-haspopup");
  });

  test("an explicitly placed sheet menu stays a menu with one action", () => {
    const html = render(
      <ActionMenu
        alwaysMenu
        items={[{ label: "Ganzen Vorgang zeigen", href: "/audit?trace_id=operation" }]}
      />,
    );
    expect(html).toContain("aria-haspopup");
    expect(html).toContain(`aria-label="${translate("de", "pattern.moreActions")}"`);
  });

  test("two items are the ⋯ menu", () => {
    const html = render(
      <ActionMenu
        items={[
          { label: "Umbenennen", onSelect() {} },
          { label: "Kategorie ändern", onSelect() {} },
        ]}
      />,
    );
    expect(html).toContain("aria-haspopup");
    expect(html).toContain(`aria-label="${translate("de", "pattern.moreActions")}"`);
  });

  test("no items, no control", () => {
    expect(render(<ActionMenu items={[]} />)).toBe("");
  });
});

describe("P17 SegmentedControl", () => {
  test("every option, the chosen one on", () => {
    const html = render(
      <SegmentedControl
        label="Zeitraum"
        value="7d"
        onValueChange={() => {}}
        options={[
          { value: "24h", label: "24 h" },
          { value: "7d", label: "7 Tage" },
          { value: "30d", label: "30 Tage" },
        ]}
      />,
    );
    expect(html).toContain('data-slot="segmented-control"');
    expect(count(html, /role="radio"/g)).toBe(3);
    expect(html).toMatch(/aria-checked="true"[^>]*>7 Tage|7 Tage/);
  });

  test("a long label shrinks with an ellipsis instead of running into its neighbours", () => {
    const html = render(
      <SegmentedControl
        label="Anmeldung"
        value="current"
        onValueChange={() => {}}
        options={[
          { value: "current", label: "Schlüssel im Header Authorization, apikey" },
          { value: "none", label: "Ohne" },
        ]}
      />,
    );
    const items = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toContain("min-w-0");
      expect(item).toMatch(/ shrink /);
      expect(item).not.toMatch(/ shrink-0 /);
    }
    expect(count(html, /<span class="truncate">/g)).toBe(2);
  });
});

describe("P19 ChatCard", () => {
  test("title, one line, facts and one action", () => {
    const html = render(
      <ChatCard
        title="Änderung an upraft-auth-notify"
        line="v6 gespeichert"
        facts={[{ label: "Umgebung", value: "Produktion" }]}
        action={
          <button type="button" data-testid="x">
            Übernehmen
          </button>
        }
      />,
    );
    expect(html).toContain('data-slot="chat-card"');
    expect(html).toContain("<dl");
    expect(html).toContain("Übernehmen");
  });
});
