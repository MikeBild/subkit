import { describe, expect, test } from "bun:test";
import { PACKAGE_KINDS, type PackageApplyResult, type PackagePreviewResult } from "@/api/packages";
import { render, renderInRouter } from "@/components/cockpit/patterns/test-utils";
import type { CategoryUsage } from "@/features/catalog/model/catalog-categories-model";
import { canSubmitImport } from "@/features/settings/model/settings-packages-model";
import {
  PackageExportChoice,
  PackageExportResultView,
  PackagePreviewView,
  PackageResultView,
} from "@/features/settings/ui/package-dialogs";
import { PackageInstallsTable } from "./settings-packages";

const preview: PackagePreviewResult = {
  archive_file_id: "file_1",
  plan: {
    package_id: "tenant-export:acme",
    package_version: "3f2a9c1b7d40e8a2",
    content_digest: "a".repeat(64),
    plan_digest: "b".repeat(64),
    items: [
      { kind: "connector", key: "github@prod", action: "create", local_id: null },
      { kind: "workflow", key: "daily-report", action: "create", local_id: null },
      {
        kind: "workflow",
        key: "ga4-daily-report",
        action: "conflict",
        reason: "local_changes",
        local_id: "w1",
      },
      {
        kind: "schedule",
        key: "briefing",
        action: "conflict",
        reason: "missing_dependency",
        missing: ["workflow:briefing"],
        local_id: null,
      },
    ],
    requires: [],
    summary: { create: 2, update: 0, unchanged: 0, conflict: 2 },
  },
};

const noop = () => {};

function previewHtml(overrides: Partial<Parameters<typeof PackagePreviewView>[0]> = {}) {
  return render(
    <PackagePreviewView
      preview={preview}
      changed={false}
      refreshing={false}
      onRefresh={noop}
      {...overrides}
    />,
  );
}

describe("package import preview", () => {
  test("shows summary, actions and hints per entry", () => {
    const html = previewHtml();
    expect(html).toContain('data-testid="settings-packages-preview-summary-create"');
    expect(html).toContain("Neu 2");
    expect(html).toContain("Konflikt 2");
    expect(html).not.toContain('data-testid="settings-packages-preview-summary-update"');
    expect(html).toContain("github@prod");
    expect(html).toContain("Ohne Zugangsdaten, danach verbinden");
    expect(html).toContain("Kommt als inaktiver Entwurf");
    expect(html).toContain("Lokal geändert, wird nicht überschrieben");
    expect(html).toContain("Abhängigkeit fehlt: workflow:briefing");
    expect(html).toContain('data-testid="settings-packages-preview-landing"');
    expect(html).not.toContain('data-testid="settings-packages-preview-changed"');
    expect(html).toContain("Hinweis");
    expect(canSubmitImport(preview.plan, false)).toBe(true);
  });

  test("blocks apply and offers a new preview when the target changed", () => {
    const html = previewHtml({ changed: true });
    expect(html).toContain('data-testid="settings-packages-preview-changed"');
    expect(html).toContain('data-testid="settings-packages-preview-refresh"');
    expect(html).toMatch(
      /<button[^>]*type="button"[^>]*data-testid="settings-packages-preview-refresh"/,
    );
    expect(canSubmitImport(preview.plan, true)).toBe(false);
  });

  test("blocks apply when nothing would change", () => {
    const plan = {
      ...preview.plan,
      items: [
        { kind: "file" as const, key: "logo.svg", action: "unchanged" as const, local_id: "f1" },
      ],
      summary: { create: 0, update: 0, unchanged: 1, conflict: 0 },
    };
    const html = previewHtml({ preview: { ...preview, plan } });
    expect(html).toContain('data-testid="settings-packages-preview-nothing"');
    expect(html).toContain("Bereits vorhanden");
    expect(canSubmitImport(plan, false)).toBe(false);
  });
});

function usage(category: string, counts: Partial<CategoryUsage["counts"]> = {}): CategoryUsage {
  return {
    category,
    total: Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0),
    counts: {
      workflow: 0,
      connector: 0,
      knowledge_source: 0,
      skill: 0,
      file: 0,
      task: 0,
      ...counts,
    },
    purpose: category === "billing" ? "Invoices and payment runs" : null,
    aliases: [],
  };
}

function choiceHtml(overrides: Partial<Parameters<typeof PackageExportChoice>[0]> = {}): string {
  return render(
    <PackageExportChoice
      kinds={new Set(PACKAGE_KINDS)}
      onKind={noop}
      categories={[
        usage("crm", { workflow: 3, connector: 1 }),
        usage("billing", { skill: 2 }),
        usage("other", { workflow: 4 }),
        usage("platform", { connector: 2 }),
      ]}
      selected={new Set(["crm"])}
      onCategory={noop}
      search=""
      onSearch={noop}
      {...overrides}
    />,
  );
}

function checkboxChecked(html: string, testId: string): boolean {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`${testId} missing`);
  return tag.includes('aria-checked="true"');
}

describe("package export choice", () => {
  test("checks the prefilled categories and leaves out other and platform", () => {
    const html = choiceHtml();
    expect(checkboxChecked(html, "settings-packages-category-crm")).toBe(true);
    expect(checkboxChecked(html, "settings-packages-category-billing")).toBe(false);
    expect(html).not.toContain('data-testid="settings-packages-category-other"');
    expect(html).not.toContain('data-testid="settings-packages-category-platform"');
    expect(html).toContain("Nur die gewählten Kategorien.");
    expect(html).not.toContain('data-testid="settings-packages-category-search"');
  });

  test("counts only the selected kinds and hides categories without them", () => {
    const html = choiceHtml({ kinds: new Set(["skill"]), selected: new Set() });
    expect(html).toContain('data-testid="settings-packages-category-billing"');
    expect(html).not.toContain('data-testid="settings-packages-category-crm"');
    expect(html).toContain("Keine Kategorie gewählt");
  });

  test("offers a search above twelve categories and filters by purpose", () => {
    const many = Array.from({ length: 13 }, (_, index) => usage(`team-${index}`, { workflow: 1 }));
    const categories = [...many, usage("billing", { workflow: 1 })];
    expect(choiceHtml({ categories, selected: new Set() })).toContain(
      'data-testid="settings-packages-category-search"',
    );
    const html = choiceHtml({ categories, selected: new Set(), search: "invoices" });
    expect(html).toContain('data-testid="settings-packages-category-billing"');
    expect(html).not.toContain('data-testid="settings-packages-category-team-0"');
  });
});

describe("package export result", () => {
  test("shows file, counts and what the target needs", () => {
    const html = render(
      <PackageExportResultView
        result={{
          file_id: "file_1",
          filename: "acme-3f2a9c1b7d40e8a2.subkit-package.zip",
          sha256: "c".repeat(64),
          size_bytes: 5 * 1024 * 1024,
          content_digest: "a".repeat(64),
          items_summary: {
            connector_template: 0,
            connector: 2,
            file: 0,
            skill: 1,
            workflow: 3,
            schedule: 0,
            knowledge: 1,
          },
          requires: [
            { kind: "credential", connector: "github@prod", fields: ["token"] },
            { kind: "credential", connector: "notion@prod", fields: ["token"] },
            { kind: "approval", workflow: "daily-report" },
          ],
        }}
        downloading={false}
        onDownload={noop}
      />,
    );
    expect(html).toContain("acme-3f2a9c1b7d40e8a2.subkit-package.zip");
    expect(html).toContain("5 MB");
    expect(html).toContain('data-testid="settings-packages-export-workflow"');
    expect(html).not.toContain('data-testid="settings-packages-export-file"');
    expect(html).toContain("Zugangsdaten für 2 Connectors neu eingeben");
    expect(html).toContain("1 Workflow-Freigabe neu erteilen");
    expect(html).toContain('data-testid="settings-packages-export-download"');
  });
});

describe("package import result", () => {
  const result: PackageApplyResult = {
    install_id: "11111111-1111-4111-8111-111111111111",
    plan_digest: "b".repeat(64),
    items: [
      { kind: "connector", key: "github@prod", action: "create", local_id: "c1" },
      {
        kind: "knowledge",
        key: "runbook",
        action: "create",
        local_id: null,
        review: {
          intake_item_id: "i1",
          proposal_id: "p1",
          path: "/cockpit/intake/i1?tab=review&proposal=p1",
        },
      },
      { kind: "workflow", key: "broken", action: "failed", local_id: null, errors: ["invalid"] },
    ],
    requires: [{ kind: "credential", connector: "github@prod", fields: ["token"] }],
    summary: { create: 2, update: 0, unchanged: 0, conflict: 0, failed: 1 },
  };

  test("summarizes and links the next steps", async () => {
    const html = await renderInRouter(<PackageResultView result={result} onAnother={noop} />);
    expect(html).toContain("2 angelegt, 0 aktualisiert, 0 unverändert, 0 Konflikte übersprungen.");
    expect(html).toContain('data-testid="settings-packages-result-failed"');
    expect(html).toContain("Nicht importiert: broken");
    expect(html).toContain("Zugangsdaten für 1 Connector eintragen");
    expect(html).toContain("1 Wissensvorschlag im Eingang prüfen");
    expect(html).toContain('href="/connectors"');
    expect(html).toContain('href="/intake/i1?tab=review&amp;proposal=p1"');
    expect(html).not.toContain('data-testid="settings-packages-next-skills"');
  });
});

describe("installed packages", () => {
  test("lists installs with source and result", () => {
    const html = render(
      <PackageInstallsTable
        installs={[
          {
            id: "11111111-1111-4111-8111-111111111111",
            package_id: "tenant-export:acme",
            package_version: "3f2a9c1b7d40e8a2",
            format: "subkit-package/v1",
            content_digest: "a".repeat(64),
            archive_file_id: "file_1",
            source: { instance: "https://subkit.example.test" },
            installed_by_type: "user",
            installed_by_id: null,
            summary: { create: 61, update: 2, unchanged: 0, conflict: 2, failed: 0 },
            created_at: "2026-10-28T14:09:00.000Z",
            updated_at: "2026-10-28T14:09:00.000Z",
          },
        ]}
        pending={false}
        failed={false}
        onRetry={noop}
        title="Installierte Pakete"
      />,
    );
    expect(html).toContain("tenant-export:acme");
    expect(html).toContain("subkit.example.test");
    expect(html).toContain("Neu 61 · Aktualisieren 2 · Konflikt 2");
  });
});
