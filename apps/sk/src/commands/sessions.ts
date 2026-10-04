import { existsSync, unlinkSync } from "node:fs";
import { defineCommand } from "citty";
import Fuse from "fuse.js";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  listSessionMetadata,
  loadSessionMetadata,
  resolveSessionRef,
  saveSessionMetadata,
  sessionPath,
} from "../sessions.ts";

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface SessionRow {
  conversation_id: string;
  alias?: string | null;
  title?: string | null;
  last_used_at: string;
}

function printSessionRows(rows: SessionRow[], totalMatched: number): void {
  if (rows.length === 0) {
    process.stdout.write("no cached sessions\n");
    return;
  }
  process.stdout.write(
    `${pc.bold("ID")}         ${pc.bold("ALIAS")}            ${pc.bold("TITLE")}              ${pc.bold("LAST USED")}\n`,
  );
  for (const r of rows) {
    const id = r.conversation_id.slice(0, 8);
    const alias = (r.alias ?? "-").padEnd(16);
    const title = (r.title ?? "(untitled)").slice(0, 20).padEnd(20);
    const when = fmtRelative(r.last_used_at);
    process.stdout.write(`${id}   ${alias} ${title} ${when}\n`);
  }
  if (totalMatched > rows.length) {
    process.stdout.write(`... ${totalMatched - rows.length} more (use --limit)\n`);
  }
}

export function rankSessions<T extends SessionRow>(rows: T[], query: string, limit: number): T[] {
  const fuse = new Fuse(rows, {
    threshold: 0.4,
    ignoreLocation: true,
    keys: [
      { name: "title", weight: 3 },
      { name: "alias", weight: 3 },
      { name: "conversation_id", weight: 1 },
    ],
  });
  return fuse
    .search(query)
    .slice(0, limit)
    .map((r) => r.item);
}

const lsCommand = defineCommand({
  meta: { name: "ls", description: "List cached conversation sessions for the active profile" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    search: { type: "string", description: "Filter by substring in title / alias" },
    all: { type: "boolean", description: "Show every profile, not just the active one" },
  },
  run({ args }) {
    const profile = resolveProfile();
    const filter = args.all
      ? undefined
      : {
          engine_url: profile.engine_url,
          tenant_id: profile.active_tenant_id ?? null,
        };
    const rows = listSessionMetadata(filter);
    const q =
      typeof args.search === "string" && args.search.length > 0 ? args.search.toLowerCase() : null;
    const filtered = q
      ? rows.filter(
          (r) =>
            (r.title ?? "").toLowerCase().includes(q) ||
            (r.alias ?? "").toLowerCase().includes(q) ||
            r.conversation_id.includes(q),
        )
      : rows;
    const limit = Math.max(1, Number.parseInt(args.limit, 10) || 20);
    printSessionRows(filtered.slice(0, limit), filtered.length);
  },
});

const searchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Fuzzy-search cached sessions by title / alias / id",
  },
  args: {
    query: { type: "positional", required: true, description: "Search text" },
    limit: { type: "string", description: "Max rows", default: "20" },
    all: { type: "boolean", description: "Search every profile, not just the active one" },
  },
  run({ args }) {
    const profile = resolveProfile();
    const filter = args.all
      ? undefined
      : {
          engine_url: profile.engine_url,
          tenant_id: profile.active_tenant_id ?? null,
        };
    const rows = listSessionMetadata(filter);
    const limit = Math.max(1, Number.parseInt(args.limit, 10) || 20);
    const matched = rankSessions(rows, String(args.query), limit);
    printSessionRows(matched, matched.length);
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "Show cached metadata for a session by id or alias" },
  args: {
    ref: { type: "positional", description: "Conversation id or alias", required: true },
  },
  run({ args }) {
    const profile = resolveProfile();
    const meta = resolveSessionRef(args.ref, {
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    });
    if (!meta) {
      process.stderr.write(`${pc.red("not found")}: ${args.ref}\n`);
      process.exit(1);
    }
    process.stdout.write(`${pc.bold("conversation_id")}: ${meta.conversation_id}\n`);
    if (meta.alias) process.stdout.write(`${pc.bold("alias")}:           ${meta.alias}\n`);
    if (meta.title) process.stdout.write(`${pc.bold("title")}:           ${meta.title}\n`);
    process.stdout.write(`${pc.bold("engine_url")}:      ${meta.engine_url}\n`);
    if (meta.tenant_id) process.stdout.write(`${pc.bold("tenant_id")}:       ${meta.tenant_id}\n`);
    if (meta.model) process.stdout.write(`${pc.bold("model")}:           ${meta.model}\n`);
    process.stdout.write(`${pc.bold("created_at")}:      ${meta.created_at}\n`);
    process.stdout.write(
      `${pc.bold("last_used_at")}:    ${meta.last_used_at}  (${fmtRelative(meta.last_used_at)})\n`,
    );
  },
});

const renameCommand = defineCommand({
  meta: {
    name: "rename",
    description: "Assign or change a short alias for a session (used by `sk -r <alias>`)",
  },
  args: {
    ref: { type: "positional", description: "Conversation id or existing alias", required: true },
    alias: { type: "positional", description: "New alias", required: true },
  },
  run({ args }) {
    const profile = resolveProfile();
    const meta = resolveSessionRef(args.ref, {
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    });
    if (!meta) {
      process.stderr.write(`${pc.red("not found")}: ${args.ref}\n`);
      process.exit(1);
    }
    if (!/^[a-z0-9_-]{1,48}$/.test(args.alias)) {
      process.stderr.write(
        `${pc.red("invalid alias")}: must match /^[a-z0-9_-]{1,48}$/ (lowercase, digits, dash, underscore)\n`,
      );
      process.exit(1);
    }
    const collision = listSessionMetadata({
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    }).find((r) => r.alias === args.alias && r.conversation_id !== meta.conversation_id);
    if (collision) {
      process.stderr.write(
        `${pc.red("alias in use")}: '${args.alias}' points at ${collision.conversation_id.slice(0, 8)}\n`,
      );
      process.exit(1);
    }
    saveSessionMetadata({ ...meta, alias: args.alias, last_used_at: meta.last_used_at });
    process.stdout.write(`${pc.green("ok")} ${meta.conversation_id.slice(0, 8)} → ${args.alias}\n`);
  },
});

const rmCommand = defineCommand({
  meta: {
    name: "rm",
    description:
      "Drop a session from the local cache (the server-side conversation row is preserved)",
  },
  args: {
    ref: { type: "positional", description: "Conversation id or alias", required: true },
  },
  run({ args }) {
    const profile = resolveProfile();
    const meta = resolveSessionRef(args.ref, {
      engine_url: profile.engine_url,
      tenant_id: profile.active_tenant_id ?? null,
    });
    if (!meta) {
      process.stderr.write(`${pc.red("not found")}: ${args.ref}\n`);
      process.exit(1);
    }
    const path = sessionPath(meta.conversation_id);
    if (existsSync(path)) unlinkSync(path);
    process.stdout.write(
      `${pc.green("ok")} removed ${meta.conversation_id.slice(0, 8)}${meta.alias ? ` (${meta.alias})` : ""} from local cache\n`,
    );
    process.stdout.write(
      `${pc.dim("the server-side conversation row is preserved; use `sk -r ")}${meta.conversation_id.slice(0, 8)}${pc.dim("` to reattach")}\n`,
    );
    void loadSessionMetadata;
  },
});

export const sessionsCommand = defineCommand({
  meta: { name: "sessions", description: "Manage locally-cached conversation sessions" },
  subCommands: {
    ls: lsCommand,
    search: searchCommand,
    show: showCommand,
    rename: renameCommand,
    rm: rmCommand,
  },
});

export { lsCommand as skLs, renameCommand as skRename, rmCommand as skRm, showCommand as skShow };
