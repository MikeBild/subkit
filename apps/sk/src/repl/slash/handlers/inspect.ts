// Read-only inspection slashes: `/skills`, `/mcp`, `/knowledge`,
// `/permissions`, `/audit`. Each is a thin `client.listX() →
// render → panify` shape, the same pattern as `admin-lists.ts`
// but for the non-admin tier. Extracted from handler.ts (R7-S2
// review fix) so the main switch keeps focus on stateful /
// interactive cases.
//
// Returns:
//   - `string | null` if the command was handled (string = banner,
//     null = pane was opened)
//   - `undefined` if the name doesn't belong to this group

import { panify, type SlashHandlerContext } from "../handler.ts";

export async function dispatchInspectSlash(
  name: string,
  ctx: SlashHandlerContext,
): Promise<string | null | undefined> {
  switch (name) {
    case "skills": {
      const r = await ctx.client.listSkills();
      if (r.items.length === 0) return "no skills in scope";
      const lines = r.items.map((s) => `${s.scope.padEnd(8)} ${s.title}`);
      return panify(ctx, "skills", lines, `${r.items.length} in scope`);
    }
    case "mcp": {
      const [prompts, resources, tools] = await Promise.all([
        ctx.client.listMcpPrompts().catch(() => ({ items: [] })),
        ctx.client.listMcpResources().catch(() => ({ items: [] })),
        ctx.client.listMcpTools().catch(() => ({ items: [] })),
      ]);
      const lines: string[] = [];
      lines.push(`prompts (${prompts.items.length}):`);
      for (const p of prompts.items) lines.push(`  /mcp__${p.name} — ${p.description ?? ""}`);
      lines.push("");
      lines.push(`resources (${resources.items.length}):`);
      for (const r of resources.items) lines.push(`  ${r.uri} · ${r.name}`);
      lines.push("");
      lines.push(`callable entries (${tools.items.length}):`);
      for (const t of tools.items) lines.push(`  ${t.name} — ${t.description}`);
      return panify(ctx, "mcp catalog", lines);
    }
    case "permissions": {
      if (ctx.allowedPermissions.length === 0) return "no permissions probe cached";
      return panify(
        ctx,
        "permissions",
        ctx.allowedPermissions.map((p) => `  ${p}`),
        `${ctx.allowedPermissions.length} granted`,
      );
    }
    case "audit": {
      const res = await ctx.client.tailAuditLog({ limit: 20 });
      const rows = res.items.slice(0, 20);
      if (rows.length === 0) return "no audit rows visible to this principal";
      const lines = rows.map((r) => {
        const action = typeof r.action === "string" ? r.action : "";
        const ts = typeof r.ts === "string" ? r.ts : "";
        const rid = typeof r.resource_id === "string" ? r.resource_id.slice(0, 8) : "";
        return `${ts}  ${action.padEnd(28)} ${rid}`;
      });
      return panify(ctx, "audit log", lines, `latest ${rows.length}`);
    }
    case "knowledge": {
      const r = await ctx.client.listKnowledgeSources({ limit: 20 });
      if (r.items.length === 0) return "no knowledge sources";
      const lines = r.items.map((ks) => {
        const k = ks as Record<string, unknown>;
        return `${String(k.id ?? "").slice(0, 8)}  ${String(k.title ?? k.name ?? "")}  ${String(k.kind ?? "")}`;
      });
      return panify(ctx, "knowledge sources", lines, `${r.items.length} found`);
    }
    default:
      return undefined;
  }
}
