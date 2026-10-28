import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import * as prompts from "@clack/prompts";
import { isEngineError, reportCommandError } from "@cli-core/errors";
import { emitList, printJson, renderTable } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import {
  EngineClient,
  type PackageApplyResult,
  type PackageItemKind,
  type PackagePlan,
} from "../engine-client.ts";

export const PACKAGE_KINDS: readonly PackageItemKind[] = [
  "connector_template",
  "connector",
  "file",
  "skill",
  "workflow",
  "schedule",
  "knowledge",
];

export const PLAN_CHANGED_EXIT_CODE = 3;

const connectionArgs = {
  profile: { type: "string" as const, description: "Profile name" },
  "engine-url": { type: "string" as const, description: "Engine base URL" },
  "api-key": { type: "string" as const, description: "API key" },
};

function makeClient(args: Record<string, unknown>): EngineClient {
  const profile = resolveProfile({
    engine_url: args["engine-url"] as string | undefined,
    api_key: args["api-key"] as string | undefined,
    profile: args.profile as string | undefined,
  });
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

export function parseKinds(raw: string | undefined): PackageItemKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw
    .split(",")
    .map((part) => part.trim().replace(/-/g, "_"))
    .filter((part) => part.length > 0);
  const unknown = kinds.filter((kind) => !PACKAGE_KINDS.includes(kind as PackageItemKind));
  if (unknown.length > 0) {
    throw new Error(`unknown kind: ${unknown.join(", ")} (known: ${PACKAGE_KINDS.join(", ")})`);
  }
  return [...new Set(kinds)] as PackageItemKind[];
}

export function parseCategories(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const categories = [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ];
  return categories.length > 0 ? categories : undefined;
}

type Requirement = PackagePlan["requires"][number];

export function describeRequirement(req: Requirement): string {
  switch (req.kind) {
    case "credential":
      return req.fields.length > 0
        ? `enter credentials for connector ${req.connector} (${req.fields.join(", ")})`
        : `enter credentials for connector ${req.connector}`;
    case "approval":
      return `review and approve workflow ${req.workflow}`;
    case "schedule_resume":
      return `resume the schedule of workflow ${req.workflow}`;
    case "knowledge_review":
      return `confirm knowledge ${req.knowledge} in the Cockpit review`;
  }
}

function renderRequirements(
  requires: readonly Requirement[],
  heading = "Afterwards on this engine:",
): string[] {
  if (requires.length === 0) return [];
  return ["", heading, ...requires.map((r) => `  - ${describeRequirement(r)}`)];
}

export function renderPackagePlan(plan: PackagePlan): string {
  const lines = [`Package ${plan.package_id} ${plan.package_version}`];
  const rows = plan.items.map((item) => ({
    action: item.action,
    kind: item.kind,
    key: item.key,
    note: [item.reason, item.missing?.length ? `missing ${item.missing.join(", ")}` : undefined]
      .filter(Boolean)
      .join("; "),
  }));
  const table = renderTable(["action", "kind", "key", "note"], rows);
  lines.push(table.length > 0 ? table : "(no items)");
  const s = plan.summary;
  lines.push(
    "",
    `create ${s.create} · update ${s.update} · unchanged ${s.unchanged} · conflict ${s.conflict}`,
  );
  if (s.conflict > 0) lines.push("Conflicting items are skipped and never overwritten.");
  lines.push(...renderRequirements(plan.requires));
  return lines.join("\n");
}

export function reviewUrl(engineUrl: string, path: string): string {
  return `${engineUrl.replace(/\/+$/, "")}${path}`;
}

export function renderApplyResult(result: PackageApplyResult, engineUrl: string): string {
  const s = result.summary;
  const lines = [
    result.install_id ? `Imported as install ${result.install_id}` : "Nothing was imported",
    `create ${s.create} · update ${s.update} · unchanged ${s.unchanged} · conflict ${s.conflict} · failed ${s.failed}`,
  ];
  const failed = result.items.filter((item) => item.action === "failed");
  if (failed.length > 0) {
    lines.push("", "Failed:");
    for (const item of failed) {
      lines.push(`  - ${item.kind} ${item.key}: ${(item.errors ?? []).join("; ") || "failed"}`);
    }
  }
  const reviews = result.items.filter((item) => item.review);
  if (reviews.length > 0) {
    lines.push("", "Review:");
    for (const item of reviews) {
      if (item.review) lines.push(`  - ${item.key}: ${reviewUrl(engineUrl, item.review.path)}`);
    }
  }
  lines.push(...renderRequirements(result.requires));
  return lines.join("\n");
}

export function planChangedPlan(err: unknown): PackagePlan | null {
  if (!isEngineError(err) || err.status !== 409 || err.code !== "package_plan_changed") {
    return null;
  }
  const details = err.details as { plan?: PackagePlan } | null | undefined;
  return details?.plan ?? null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const exportCmd = defineCommand({
  meta: {
    name: "export",
    description:
      "Export this workspace as a package archive (workflows, connectors without credentials, templates, skills, schedules, knowledge, files)",
  },
  args: {
    out: { type: "string", required: true, description: "Path of the archive to write" },
    only: {
      type: "string",
      description: `Comma-separated kinds to export (${PACKAGE_KINDS.join(", ")})`,
    },
    category: {
      type: "string",
      description: "Comma-separated catalog categories to export, one area per package",
    },
    json: { type: "boolean", description: "JSON output" },
    ...connectionArgs,
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    try {
      const kinds = parseKinds(args.only as string | undefined);
      const categories = parseCategories(args.category as string | undefined);
      const client = makeClient(args);
      const exported = await client.exportPackage({
        ...(kinds ? { kinds } : {}),
        ...(categories ? { categories } : {}),
      });
      const archive = await client.downloadPackageArchive(exported.file_id);
      const actual = sha256Hex(archive.bytes);
      if (actual !== exported.sha256) {
        throw new Error(`downloaded archive checksum mismatch (expected ${exported.sha256})`);
      }
      const out = String(args.out);
      writeFileSync(out, archive.bytes);
      if (asJson) {
        printJson({ ...exported, out });
        return;
      }
      const counts = Object.entries(exported.items_summary)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(" · ");
      const lines = [
        `wrote ${out} (${exported.size_bytes} bytes, sha256 ${exported.sha256})`,
        counts.length > 0 ? counts : "the package is empty",
        ...renderRequirements(exported.requires, "Afterwards on the target engine:"),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    } catch (err) {
      reportCommandError(err, { json: asJson });
    }
  },
});

const importCmd = defineCommand({
  meta: {
    name: "import",
    description:
      "Import a package archive: shows the plan, asks for confirmation (--yes to skip), then applies exactly that plan",
  },
  args: {
    file: { type: "positional", required: true, description: "Package archive (.zip)" },
    yes: { type: "boolean", description: "Apply without asking" },
    json: { type: "boolean", description: "JSON output" },
    ...connectionArgs,
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    try {
      const client = makeClient(args);
      const path = String(args.file);
      const bytes = new Uint8Array(readFileSync(path));
      const preview = await client.previewPackageUpload({ name: basename(path), bytes });
      const { plan } = preview;
      if (!asJson) process.stdout.write(`${renderPackagePlan(plan)}\n`);
      if (plan.summary.create + plan.summary.update === 0) {
        if (asJson) printJson({ archive_file_id: preview.archive_file_id, plan, result: null });
        else process.stdout.write("\nNothing to import.\n");
        return;
      }
      if (!args.yes) {
        if (asJson || !process.stdin.isTTY) {
          if (asJson) printJson({ archive_file_id: preview.archive_file_id, plan, result: null });
          process.stderr.write(
            "error: refusing to import without confirmation. Re-run with --yes to apply this plan.\n",
          );
          process.exit(2);
        }
        const confirmed = await prompts.confirm({ message: "Apply this plan?" });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      const result = await client.applyPackage({
        archive_file_id: preview.archive_file_id,
        expected_plan_digest: plan.plan_digest,
      });
      if (asJson) {
        printJson({ archive_file_id: preview.archive_file_id, plan, result });
        return;
      }
      process.stdout.write(`\n${renderApplyResult(result, client.base)}\n`);
    } catch (err) {
      const changed = planChangedPlan(err);
      if (changed) {
        if (asJson) printJson({ error: "package_plan_changed", plan: changed });
        else {
          process.stdout.write(`\n${renderPackagePlan(changed)}\n`);
          process.stderr.write(
            "error: this engine changed after the preview; nothing was imported. Run the import again.\n",
          );
        }
        process.exit(PLAN_CHANGED_EXIT_CODE);
      }
      reportCommandError(err, { json: asJson });
    }
  },
});

const installsCmd = defineCommand({
  meta: { name: "installs", description: "List past package imports, or show one with its items" },
  args: {
    id: { type: "positional", required: false, description: "Install id" },
    json: { type: "boolean", description: "JSON output" },
    ...connectionArgs,
  },
  async run({ args }) {
    const asJson = Boolean(args.json);
    try {
      const client = makeClient(args);
      if (args.id) {
        const detail = await client.getPackageInstall(String(args.id));
        if (asJson) {
          printJson(detail);
          return;
        }
        process.stdout.write(
          `${detail.package_id} ${detail.package_version} · ${detail.created_at}\n`,
        );
        emitList(false, ["kind", "item_key", "state", "local_id"], detail.items);
        return;
      }
      const items = await client.listPackageInstalls();
      emitList(
        asJson,
        ["id", "package_id", "package_version", "created_at"],
        items as unknown as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: asJson });
    }
  },
});

export const packagesCommand = defineCommand({
  meta: {
    name: "packages",
    description:
      "Move this workspace to another engine: export a package archive, import one with a reviewed plan, list past imports",
  },
  subCommands: { export: exportCmd, import: importCmd, installs: installsCmd },
});
