// Admin-tier list slashes — each is a near-identical
// `client.listX() → render rows → panify` pattern. Extracted from
// the main `handler.ts` switch (R7-S2 review fix) so a future
// reviewer adding a new admin list command sees ~150 LOC instead
// of the full 1800-line dispatch.
//
// Returns:
//   - `string | null` if the command was handled (string = banner,
//     null = pane was opened)
//   - `undefined` if the name doesn't belong to this group; the
//     main dispatcher should fall through to the next handler.

import { panify, type SlashHandlerContext } from "../handler.ts";

export async function dispatchAdminListSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "connectors": {
      const r = await ctx.client.listConnectors({ limit: 20 });
      if (r.items.length === 0) return "no connectors";
      const lines = r.items.map((c) => {
        const ct = c as Record<string, unknown>;
        return `${String(ct.id ?? "").slice(0, 8)}  ${String(ct.name ?? "").padEnd(20)}  ${String(ct.slug ?? "")}`;
      });
      return panify(ctx, "connectors", lines, `${r.items.length} found`);
    }
    case "workflows": {
      const r = await ctx.client.listWorkflows({ limit: 20 });
      if (r.items.length === 0) return "no workflows";
      const lines = r.items.map((w) => {
        const wf = w as Record<string, unknown>;
        return `${String(wf.id ?? "").slice(0, 8)}  ${String(wf.name ?? "").padEnd(20)}  ${String(wf.status ?? "")}`;
      });
      return panify(ctx, "workflows", lines, `${r.items.length} found`);
    }
    case "executions":
    case "runs": {
      const r = await ctx.client.listExecutions({ limit: 10 });
      if (r.items.length === 0) return "no executions";
      const lines = r.items.map((e) => {
        const ex = e as Record<string, unknown>;
        return `${String(ex.id ?? "").slice(0, 8)}  wf:${String(ex.workflow_id ?? "").slice(0, 8)}  ${String(ex.status ?? "").padEnd(12)}  ${String(ex.started_at ?? "")}`;
      });
      return panify(ctx, "executions", lines, `latest ${r.items.length}`);
    }
    case "patch-candidates": {
      const r = await ctx.client.listPatchCandidates({ limit: 10 });
      if (r.items.length === 0) return "no pending patch candidates";
      const lines = r.items.map((p) => {
        const pc = p as Record<string, unknown>;
        return `${String(pc.id ?? "").slice(0, 8)}  wf:${String(pc.workflow_id ?? "").slice(0, 8)}  ${String(pc.status ?? "")}`;
      });
      return panify(ctx, "patch candidates", lines, `${r.items.length} pending`);
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
          `  ${String(r.id ?? "").slice(0, 8)}  ${String(r.event_type ?? "").padEnd(24)}  → ch:${String(r.channel_id ?? "").slice(0, 8)}`,
        );
      }
      return panify(ctx, "notifications", lines);
    }
    case "tunnels": {
      const r = await ctx.client.listTunnels();
      if (r.items.length === 0) return "no tunnels";
      const lines = r.items.map((t) => {
        const tun = t as Record<string, unknown>;
        return `${String(tun.id ?? "").slice(0, 8)}  ${String(tun.name ?? "").padEnd(20)}  ${String(tun.status ?? "")}`;
      });
      return panify(ctx, "tunnels", lines, `${r.items.length} found`);
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
    case "apikeys": {
      const r = await ctx.client.listApiKeys();
      if (r.items.length === 0) return "no API keys";
      const lines = r.items.map((k) => {
        const ak = k as Record<string, unknown>;
        return `${String(ak.id ?? "").slice(0, 8)}  ${String(ak.name ?? "").padEnd(20)}  ${String(ak.prefix ?? "***")}`;
      });
      return panify(ctx, "API keys", lines, `${r.items.length} keys`);
    }
    case "users": {
      const r = await ctx.client.listIdentityUsers({ limit: 20 });
      if (r.items.length === 0) return "no users";
      const lines = r.items.map((u) => {
        const user = u as Record<string, unknown>;
        return `${String(user.id ?? "").slice(0, 8)}  ${String(user.email ?? "").padEnd(30)}  ${String(user.kind ?? "")}`;
      });
      return panify(ctx, "users", lines, `${r.items.length} found`);
    }
    case "system-accounts": {
      const r = await ctx.client.listSystemAccounts();
      if (r.items.length === 0) return "no system accounts";
      const lines = r.items.map((sa) => {
        const acc = sa as Record<string, unknown>;
        return `${String(acc.id ?? "").slice(0, 8)}  ${String(acc.name ?? "")}`;
      });
      return panify(ctx, "system accounts", lines, `${r.items.length} found`);
    }
    default:
      return undefined;
  }
}
