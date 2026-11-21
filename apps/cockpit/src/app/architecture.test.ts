import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const COCKPIT = join(ROOT, "apps/cockpit/src");
const UI = join(ROOT, "packages/ui/src");

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

type Layer =
  | "pages"
  | "features"
  | "app"
  | "cockpit"
  | "patterns"
  | "ui"
  | "components"
  | "hooks"
  | "lib"
  | "api"
  | "queries"
  | "ds"
  | "ds-controls"
  | "other";

function layerOfSpecifier(spec: string): Layer | null {
  if (spec.startsWith("@ui/components/ui/")) return "ds-controls";
  if (spec.startsWith("@ui/")) return "ds";
  if (!spec.startsWith("@/")) return null;
  const path = spec.slice(2);
  if (path.startsWith("pages/")) return "pages";
  if (path.startsWith("features/")) return "features";
  if (path.startsWith("app/")) return "app";
  if (path.startsWith("components/ui/")) return "ui";
  if (path.startsWith("components/cockpit/patterns")) return "patterns";
  if (path.startsWith("components/cockpit/")) return "cockpit";
  if (path.startsWith("components/")) return "components";
  if (path.startsWith("hooks/")) return "hooks";
  if (path.startsWith("lib/")) return "lib";
  if (path.startsWith("api/")) return "api";
  if (path.startsWith("queries/")) return "queries";
  return "other";
}

function areaOf(file: string): string {
  const path = relative(COCKPIT, file);
  if (!path.includes("/")) return "root";
  if (path.startsWith("components/ui/")) return "components/ui";
  if (path.startsWith("components/cockpit/patterns/")) return "components/cockpit/patterns";
  if (path.startsWith("components/cockpit/")) return "components/cockpit";
  if (path.startsWith("components/")) return "components";
  return path.slice(0, path.indexOf("/"));
}

const FORBIDDEN: Record<string, readonly Layer[]> = {
  root: ["ds-controls"],
  app: ["ds-controls"],
  pages: [],
  features: ["pages"],
  "components/cockpit": ["pages", "features"],
  "components/cockpit/patterns": ["pages", "features", "api", "queries", "ds-controls"],
  components: ["pages", "features", "ds-controls"],
  "components/ui": [
    "pages",
    "features",
    "app",
    "cockpit",
    "components",
    "api",
    "queries",
    "patterns",
  ],
  hooks: [
    "pages",
    "features",
    "app",
    "cockpit",
    "patterns",
    "components",
    "api",
    "queries",
    "ds-controls",
  ],
  lib: ["pages", "features", "cockpit", "ui", "patterns", "components", "ds", "ds-controls"],
  queries: [
    "pages",
    "features",
    "cockpit",
    "ui",
    "patterns",
    "components",
    "hooks",
    "ds",
    "ds-controls",
  ],
  api: [
    "pages",
    "features",
    "cockpit",
    "ui",
    "patterns",
    "components",
    "hooks",
    "queries",
    "ds",
    "ds-controls",
  ],
};

function cockpitViolations(): string[] {
  const out = new Set<string>();
  for (const file of sources(COCKPIT)) {
    const forbidden = FORBIDDEN[areaOf(file)] ?? [];
    for (const spec of imports(file)) {
      const layer = layerOfSpecifier(spec);
      if (layer && forbidden.includes(layer)) out.add(`${relative(COCKPIT, file)} -> ${spec}`);
    }
  }
  return [...out].sort();
}

function featureInternals(): string[] {
  const out = new Set<string>();
  for (const file of sources(COCKPIT)) {
    const own = relative(COCKPIT, file).match(/^features\/([^/]+)\//)?.[1];
    for (const spec of imports(file)) {
      const target = spec.match(/^@\/features\/([^/]+)\/(.+)$/);
      if (target && target[1] !== own) out.add(`${relative(COCKPIT, file)} -> ${spec}`);
    }
  }
  return [...out].sort();
}

function unclassified(): string[] {
  const out = new Set<string>();
  for (const file of sources(COCKPIT)) {
    if (!(areaOf(file) in FORBIDDEN)) out.add(`area: ${relative(COCKPIT, file)}`);
    for (const spec of imports(file)) {
      if (layerOfSpecifier(spec) === "other") out.add(`${relative(COCKPIT, file)} -> ${spec}`);
    }
  }
  return [...out].sort();
}

const DEBT = new Set<string>([
  "components/cockpit/automation-grant.tsx -> @/pages/chat-automation-tool",
  "components/cockpit/automation-panel.tsx -> @/pages/decisions-context",
  "components/cockpit/automation-panel.tsx -> @/pages/decisions-model",
  "components/cockpit/automation-panel.tsx -> @/pages/runs-model",
  "components/cockpit/change-summary.tsx -> @/pages/decisions-model",
  "components/cockpit/connector-credentials.tsx -> @/pages/connections-model",
  "components/cockpit/connector-credentials.tsx -> @/pages/connector-detail-model",
  "components/cockpit/connector-detail.tsx -> @/pages/catalog-model",
  "components/cockpit/connector-detail.tsx -> @/pages/connector-detail-model",
  "components/cockpit/connector-detail.tsx -> @/pages/workflows-model",
  "components/cockpit/connector-edit.tsx -> @/pages/connector-detail-model",
  "components/cockpit/connector-page.tsx -> @/pages/connector-detail-model",
  "components/cockpit/connector-view-model.ts -> @/pages/connector-detail-model",
  "components/cockpit/create-connector-model.ts -> @/pages/connector-detail-model",
  "components/cockpit/create-connector.tsx -> @/pages/connector-detail-model",
  "components/cockpit/decision-card.tsx -> @/pages/decisions-context",
  "components/cockpit/decision-card.tsx -> @/pages/decisions-model",
  "components/cockpit/grant-task-authority.tsx -> @/features/operations",
  "components/cockpit/grant-workflow-authority.tsx -> @/features/operations",
  "components/cockpit/installation-dialogs.tsx -> @/features/pwa",
  "components/cockpit/package-dialogs.tsx -> @/pages/settings-packages-model",
  "components/cockpit/patterns/workspace-menu.tsx -> @/api/memberships",
  "components/cockpit/patterns/workspace-recovery.tsx -> @/api/tenant-lifecycle",
  "components/cockpit/prepared-changes.tsx -> @/pages/settings-model",
  "components/cockpit/run-sheet.ts -> @/pages/runs-model",
  "components/cockpit/schedule-history.tsx -> @/features/operations",
  "components/cockpit/skill-proposal-sheet.tsx -> @/pages/decisions-model",
  "components/cockpit/waiting-on.tsx -> @/pages/overview-model",
  "components/cockpit/workflow-invocation.tsx -> @/features/admin",
  "components/cockpit/workflow-invocation.tsx -> @/pages/api-access-model",
  "components/cockpit/workflow-page.tsx -> @/features/admin",
  "components/cockpit/workflow-page.tsx -> @/features/operations",
  "components/cockpit/workflow-page.tsx -> @/pages/runs-model",
  "components/cockpit/workflow-page.tsx -> @/pages/workflows-model",
  "components/cockpit/workflow-review-dialog.tsx -> @/features/operations",
  "components/cockpit/workflow-review.tsx -> @/features/operations",
  "components/cockpit/workflow-runs.tsx -> @/features/operations",
  "components/cockpit/workflow-runs.tsx -> @/pages/runs-model",
  "components/cockpit/workflow-steps-list.tsx -> @/pages/runs-model",
  "components/cockpit/workflow-versions.tsx -> @/features/admin",
  "features/chat/composer-area.tsx -> @/pages/chat-attachments",
  "features/chat/composer-area.tsx -> @/pages/chat-mode",
  "features/chat/composer-area.tsx -> @/pages/chat-permission",
  "features/chat/composer-area.tsx -> @/pages/chat-text",
  "features/chat/composer-area.tsx -> @/pages/chat-turn",
  "features/chat/composer.tsx -> @/pages/chat-attachments",
  "features/chat/composer.tsx -> @/pages/chat-text",
  "features/chat/context-content.tsx -> @/pages/chat-approval",
  "features/chat/context-content.tsx -> @/pages/chat-held-schedule",
  "features/chat/context-content.tsx -> @/pages/chat-playbook-panel",
  "features/chat/context-content.tsx -> @/pages/chat-references",
  "features/chat/context-content.tsx -> @/pages/chat-resume",
  "features/chat/conversation-head.tsx -> @/pages/chat-policy",
  "features/chat/conversation-head.tsx -> @/pages/chat-turn",
  "features/chat/conversation-head.tsx -> @/pages/chat-workspace",
  "features/chat/index.ts -> @/pages/chat-selection",
  "features/chat/labels.ts -> @/pages/chat-preview-cards",
  "features/chat/list-panel.tsx -> @/pages/chat-conversation-list",
  "features/chat/message.tsx -> @/pages/chat-approval",
  "features/chat/message.tsx -> @/pages/chat-approval-card",
  "features/chat/message.tsx -> @/pages/chat-attachments",
  "features/chat/message.tsx -> @/pages/chat-choice",
  "features/chat/message.tsx -> @/pages/chat-choice-card",
  "features/chat/message.tsx -> @/pages/chat-form",
  "features/chat/message.tsx -> @/pages/chat-form-card",
  "features/chat/message.tsx -> @/pages/chat-judge-findings-card",
  "features/chat/message.tsx -> @/pages/chat-message-link",
  "features/chat/message.tsx -> @/pages/chat-preview-cards",
  "features/chat/message.tsx -> @/pages/chat-reauth",
  "features/chat/message.tsx -> @/pages/chat-reauth-card",
  "features/chat/message.tsx -> @/pages/chat-references",
  "features/chat/message.tsx -> @/pages/chat-sensitive-preview-card",
  "features/chat/message.tsx -> @/pages/chat-session",
  "features/chat/message.tsx -> @/pages/chat-task-run",
  "features/chat/message.tsx -> @/pages/chat-test-run",
  "features/chat/message.tsx -> @/pages/chat-test-run-card",
  "features/chat/message.tsx -> @/pages/chat-text",
  "features/chat/message.tsx -> @/pages/chat-transcript",
  "features/chat/parts.tsx -> @/pages/chat-attachments",
  "features/chat/policy.tsx -> @/pages/chat-policy",
  "features/chat/policy.tsx -> @/pages/chat-turn",
  "features/chat/question-dock.tsx -> @/pages/chat-approval",
  "features/chat/question-dock.tsx -> @/pages/chat-approval-card",
  "features/chat/question-dock.tsx -> @/pages/chat-choice",
  "features/chat/question-dock.tsx -> @/pages/chat-choice-card",
  "features/chat/question-dock.tsx -> @/pages/chat-form",
  "features/chat/question-dock.tsx -> @/pages/chat-form-card",
  "features/chat/question-dock.tsx -> @/pages/chat-held-schedule",
  "features/chat/question-dock.tsx -> @/pages/chat-resume",
  "features/chat/question-dock.tsx -> @/pages/chat-turn",
  "features/chat/task-run-line.tsx -> @/pages/chat-playbook",
  "features/chat/task-run-line.tsx -> @/pages/chat-task-run",
  "features/chat/task-run-line.tsx -> @/pages/tasks-stop-dialog",
  "features/chat/transcript.tsx -> @/pages/chat-live-calls",
  "features/chat/transcript.tsx -> @/pages/chat-lookups",
  "features/chat/transcript.tsx -> @/pages/chat-questions",
  "features/chat/transcript.tsx -> @/pages/chat-session",
  "features/chat/transcript.tsx -> @/pages/chat-turn",
  "lib/connector-strip.ts -> @/pages/connector-detail-model",
  "lib/intake-model.ts -> @/components/cockpit/service-icon",
  "lib/tool-parts.ts -> @/components/ai-elements/tool",
]);

const INTERNAL_DEBT = new Set<string>([
  "pages/chat-approval-card.tsx -> @/features/chat/policy",
  "pages/settings-profile.tsx -> @/features/feedback/desktop-bridge",
]);

const DEBT_CEILING = 103;
const INTERNAL_DEBT_CEILING = 2;

describe("architecture: dependencies point downward", () => {
  test("packages/ui imports nothing from an app, an API or a domain module", () => {
    const leaks = sources(UI).flatMap((file) =>
      imports(file)
        .filter((spec) => /^(@\/|@engine|@shared|@cli-core|@chat-ui|\.\.\/\.\.\/\.\.\/)/.test(spec))
        .map((spec) => `${relative(UI, file)} -> ${spec}`),
    );
    expect(leaks).toEqual([]);
  });

  test("packages/ui makes no network calls", () => {
    const calls = sources(UI).filter((file) =>
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(readFileSync(file, "utf8")),
    );
    expect(calls.map((file) => relative(UI, file))).toEqual([]);
  });

  test("no layer imports a layer above it (except listed debt)", () => {
    expect(cockpitViolations().filter((v) => !DEBT.has(v))).toEqual([]);
  });

  test("listed debt still exists — a fixed import leaves the list", () => {
    const found = new Set(cockpitViolations());
    expect([...DEBT].filter((v) => !found.has(v))).toEqual([]);
  });

  test("other features are reached only through their index.ts", () => {
    expect(featureInternals().filter((v) => !INTERNAL_DEBT.has(v))).toEqual([]);
  });

  test("listed feature-internal debt still exists", () => {
    const found = new Set(featureInternals());
    expect([...INTERNAL_DEBT].filter((v) => !found.has(v))).toEqual([]);
  });

  test("the debt lists only shrink", () => {
    expect(DEBT.size).toBeLessThanOrEqual(DEBT_CEILING);
    expect(INTERNAL_DEBT.size).toBeLessThanOrEqual(INTERNAL_DEBT_CEILING);
  });

  test("every source file and every app import belongs to a classified layer", () => {
    expect(unclassified()).toEqual([]);
  });

  test("every classified area still has files to check", () => {
    const areas = new Set(sources(COCKPIT).map(areaOf));
    expect(Object.keys(FORBIDDEN).filter((area) => !areas.has(area))).toEqual([]);
  });
});
