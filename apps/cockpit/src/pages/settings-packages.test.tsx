import { describe, expect, test } from "bun:test";
import type { PackageApplyResult, PackagePreviewResult } from "@/api/packages";
import { render, renderInRouter } from "@/components/cockpit/patterns/test-utils";
import {
  PackageExportResultView,
  PackageInstallsTable,
  PackagePreviewView,
  PackageResultView,
} from "@/pages/settings-packages";

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

function applyDisabled(html: string): boolean {
  const tag = html.match(/<button[^>]*data-testid="settings-packages-preview-apply"[^>]*>/)?.[0];
  if (!tag) throw new Error("apply button missing");
  return /\sdisabled=""/.test(tag);
}

function previewHtml(overrides: Partial<Parameters<typeof PackagePreviewView>[0]> = {}) {
  return render(
    <PackagePreviewView
      preview={preview}
      changed={false}
      refreshing={false}
      applying={false}
      onCancel={noop}
      onApply={noop}
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
    expect(applyDisabled(html)).toBe(false);
  });

  test("blocks apply and offers a new preview when the target changed", () => {
    const html = previewHtml({ changed: true });
    expect(html).toContain('data-testid="settings-packages-preview-changed"');
    expect(html).toContain('data-testid="settings-packages-preview-refresh"');
    expect(applyDisabled(html)).toBe(true);
  });

  test("blocks apply when nothing would change", () => {
    const html = previewHtml({
      preview: {
        ...preview,
        plan: {
          ...preview.plan,
          items: [{ kind: "file", key: "logo.svg", action: "unchanged", local_id: "f1" }],
          summary: { create: 0, update: 0, unchanged: 1, conflict: 0 },
        },
      },
    });
    expect(html).toContain('data-testid="settings-packages-preview-nothing"');
    expect(html).toContain("Bereits vorhanden");
    expect(applyDisabled(html)).toBe(true);
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
    expect(html).toContain("5.0 MB");
    expect(html).toContain('data-testid="settings-packages-export-workflow"');
    expect(html).not.toContain('data-testid="settings-packages-export-file"');
    expect(html).toContain("Zugangsdaten für 2 Konnektoren neu eingeben");
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
    expect(html).toContain("Zugangsdaten für 1 Konnektor eintragen");
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
