import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { panify, type SlashHandlerContext } from "../handler.ts";

type PackageInstall = components["schemas"]["PackageInstall"];
type NotificationChannelList = components["schemas"]["NotificationChannelListResponse"];
type NotificationRuleList = components["schemas"]["NotificationRuleListResponse"];

export async function dispatchAdminListSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "connectors": {
      const r = await ctx.client.listConnectors({ limit: 20 });
      const items = r.items;
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
      const items = r.items;
      if (items.length === 0) return "no workflows";
      const lines = items.map((w) => `${w.id.slice(0, 8)}  ${w.name.padEnd(20)}  ${w.lifecycle}`);
      const footer =
        items.length < r.total ? `showing ${items.length} of ${r.total}` : `${r.total} total`;
      return panify(ctx, "workflows", lines, footer);
    }
    case "executions":
    case "runs": {
      const r = await ctx.client.listExecutions({ limit: 10 });
      const items = r.items;
      if (items.length === 0) return "no executions";
      const lines = items.map((e) => {
        const wfId = (e.workflow_id ?? "").slice(0, 8);
        const startedAt = e.started_at ?? "";
        return `${e.id.slice(0, 8)}  wf:${wfId}  ${e.status.padEnd(12)}  ${startedAt}`;
      });
      return panify(ctx, "executions", lines, `latest ${items.length} of ${r.total}`);
    }
    case "patch-candidates": {
      const r = await ctx.client.listPatchCandidates({ limit: 10 });
      const items = r.items;
      if (items.length === 0) return "no pending patch candidates";
      const lines = items.map((p) => {
        const wfId = p.workflow_id.slice(0, 8);
        return `${p.id.slice(0, 8)}  wf:${wfId}  ${p.status}`;
      });
      return panify(ctx, "patch candidates", lines, `${items.length} pending`);
    }
    case "notifications": {
      const [channels, rules] = await Promise.all([
        ctx.client.listNotificationChannels().catch((): NotificationChannelList => ({ items: [] })),
        ctx.client.listNotificationRules().catch((): NotificationRuleList => ({ items: [] })),
      ]);
      const lines: string[] = [];
      lines.push(`channels (${channels.items.length}):`);
      for (const ch of channels.items) {
        lines.push(
          `  ${ch.id.slice(0, 8)}  ${ch.platform.padEnd(20)}  ${ch.workspace_id}/${ch.channel_id}`,
        );
      }
      lines.push("");
      lines.push(`rules (${rules.items.length}):`);
      for (const r of rules.items) {
        lines.push(
          `  ${r.id.slice(0, 8)}  ${r.event_pattern.padEnd(24)}  → ${r.target_workspace_id}/${r.target_channel_id}`,
        );
      }
      return panify(ctx, "notifications", lines);
    }
    case "discovery": {
      const r = await ctx.client.listDiscoveryRuns({ limit: 10 });
      if (r.items.length === 0) return "no discovery runs";
      const lines = r.items.map(
        (d) => `${d.id.slice(0, 8)}  ${(d.label ?? "").padEnd(20)}  ${d.status}`,
      );
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
      const items = r.items;
      if (items.length === 0) return "no API keys";
      const lines = items.map(
        (k) => `${k.id.slice(0, 8)}  ${(k.name ?? "").padEnd(20)}  ${k.prefix}`,
      );
      return panify(ctx, "API keys", lines, `${items.length} keys`);
    }
    case "users": {
      const r = await ctx.client.listIdentityUsers({ limit: 20 });
      if (r.items.length === 0) return "no users";
      const lines = r.items.map((u) => `${u.id.slice(0, 8)}  ${u.email.padEnd(30)}  ${u.status}`);
      return panify(ctx, "users", lines, `${r.items.length} found`);
    }
    case "system-accounts": {
      const r = await ctx.client.listSystemAccounts();
      const items = r.items;
      if (items.length === 0) return "no system accounts";
      const lines = items.map((sa) => `${sa.id.slice(0, 8)}  ${sa.name}`);
      return panify(ctx, "system accounts", lines, `${items.length} found`);
    }
    default:
      return undefined;
  }
}
