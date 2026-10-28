import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { panify, type SlashHandlerContext } from "../handler.ts";

type Connector = components["schemas"]["Connector"];
type Workflow = components["schemas"]["Workflow"];
type Execution = components["schemas"]["Execution"];
type PatchCandidate = components["schemas"]["PatchCandidate"];
type ApiKey = components["schemas"]["ApiKey"];
type SystemAccount = components["schemas"]["SystemAccount"];
type PackageInstall = components["schemas"]["PackageInstall"];

function asConnectors(items: readonly unknown[]): readonly Connector[] {
  return items as readonly Connector[];
}
function asWorkflows(items: readonly unknown[]): readonly Workflow[] {
  return items as readonly Workflow[];
}
function asExecutions(items: readonly unknown[]): readonly Execution[] {
  return items as readonly Execution[];
}
function asPatchCandidates(items: readonly unknown[]): readonly PatchCandidate[] {
  return items as readonly PatchCandidate[];
}
function asApiKeys(items: readonly unknown[]): readonly ApiKey[] {
  return items as readonly ApiKey[];
}
function asSystemAccounts(items: readonly unknown[]): readonly SystemAccount[] {
  return items as readonly SystemAccount[];
}

export async function dispatchAdminListSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "connectors": {
      const r = await ctx.client.listConnectors({ limit: 20 });
      const items = asConnectors(r.items);
      if (items.length === 0) return "no connectors";
      const lines = items.map(
        (c) => `${c.id.slice(0, 8)}  ${c.display_name.padEnd(20)}  ${c.slug}`,
      );
      const footer =
        items.length < r.total ? `showing ${items.length} of ${r.total}` : `${r.total} total`;
      return panify(ctx, "connectors", lines, footer);
    }
    case "workflows": {
      const r = await ctx.client.listWorkflows({ limit: 20 });
      const items = asWorkflows(r.items);
      if (items.length === 0) return "no workflows";
      const lines = items.map((w) => `${w.id.slice(0, 8)}  ${w.name.padEnd(20)}  ${w.lifecycle}`);
      const footer =
        items.length < r.total ? `showing ${items.length} of ${r.total}` : `${r.total} total`;
      return panify(ctx, "workflows", lines, footer);
    }
    case "executions":
    case "runs": {
      const r = await ctx.client.listExecutions({ limit: 10 });
      const items = asExecutions(r.items);
      if (items.length === 0) return "no executions";
      const lines = items.map((e) => {
        const wfId = String(e.workflow_id ?? "").slice(0, 8);
        const startedAt = String(e.started_at ?? "");
        return `${e.id.slice(0, 8)}  wf:${wfId}  ${e.status.padEnd(12)}  ${startedAt}`;
      });
      return panify(ctx, "executions", lines, `latest ${items.length} of ${r.total}`);
    }
    case "patch-candidates": {
      const r = await ctx.client.listPatchCandidates({ limit: 10 });
      const items = asPatchCandidates(r.items);
      if (items.length === 0) return "no pending patch candidates";
      const lines = items.map((p) => {
        const wfId = String(p.workflow_id ?? "").slice(0, 8);
        return `${p.id.slice(0, 8)}  wf:${wfId}  ${p.status}`;
      });
      return panify(ctx, "patch candidates", lines, `${items.length} pending`);
    }
    case "notifications": {
      const [channels, rules] = await Promise.all([
        ctx.client
          .listNotificationChannels()
          .catch(() => ({ items: [] as Record<string, unknown>[] })),
        ctx.client
          .listNotificationRules()
          .catch(() => ({ items: [] as Record<string, unknown>[] })),
      ]);
      const lines: string[] = [];
      lines.push(`channels (${channels.items.length}):`);
      for (const c of channels.items) {
        const ch = c as Record<string, unknown>;
        lines.push(
          `  ${String(ch.id ?? "").slice(0, 8)}  ${String(ch.name ?? "").padEnd(20)}  ${String(ch.kind ?? "")}`,
        );
      }
      lines.push("");
      lines.push(`rules (${rules.items.length}):`);
      for (const rule of rules.items) {
        const r = rule as Record<string, unknown>;
        lines.push(
          `  ${String(r.id ?? "").slice(0, 8)}  ${String(r.event_pattern ?? "").padEnd(24)}  → ${String(r.target_workspace_id ?? "")}/${String(r.target_channel_id ?? "")}`,
        );
      }
      return panify(ctx, "notifications", lines);
    }
    case "discovery": {
      const r = await ctx.client.listDiscoveryRuns({ limit: 10 });
      if (r.items.length === 0) return "no discovery runs";
      const lines = r.items.map((d) => {
        const dr = d as Record<string, unknown>;
        return `${String(dr.id ?? "").slice(0, 8)}  ${String(dr.label ?? "").padEnd(20)}  ${String(dr.status ?? "")}`;
      });
      return panify(ctx, "discovery runs", lines, `${r.items.length} found`);
    }
    case "packages": {
      const items: readonly PackageInstall[] = await ctx.client.listPackageInstalls();
      if (items.length === 0) return "no package imports";
      const lines = items.map(
        (i) =>
          `${i.id.slice(0, 8)}  ${i.package_id.padEnd(20)}  ${i.package_version}  ${i.created_at}`,
      );
      return panify(ctx, "package imports", lines, `${items.length} found`);
    }
    case "apikeys": {
      const r = await ctx.client.listApiKeys();
      const items = asApiKeys(r.items);
      if (items.length === 0) return "no API keys";
      const lines = items.map((k) => {
        const name = String((k as { name?: unknown }).name ?? "");
        return `${k.id.slice(0, 8)}  ${name.padEnd(20)}  ${k.prefix}`;
      });
      return panify(ctx, "API keys", lines, `${items.length} keys`);
    }
    case "users": {
      const r = await ctx.client.listIdentityUsers({ limit: 20 });
      if (r.items.length === 0) return "no users";
      const lines = r.items.map((u) => {
        const user = u as { id?: string; email?: string; kind?: string };
        return `${String(user.id ?? "").slice(0, 8)}  ${String(user.email ?? "").padEnd(30)}  ${String(user.kind ?? "")}`;
      });
      return panify(ctx, "users", lines, `${r.items.length} found`);
    }
    case "system-accounts": {
      const r = await ctx.client.listSystemAccounts();
      const items = asSystemAccounts(r.items);
      if (items.length === 0) return "no system accounts";
      const lines = items.map((sa) => `${sa.id.slice(0, 8)}  ${sa.name}`);
      return panify(ctx, "system accounts", lines, `${items.length} found`);
    }
    default:
      return undefined;
  }
}
