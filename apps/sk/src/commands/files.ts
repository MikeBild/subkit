// `sk files` — operator surface for the unified files resource.
//
// Seven verbs: list, get, upload, download, delete, link, stats. The
// `upload` verb picks inline vs presigned-PUT based on Bun.file size;
// the routing is invisible to the user. Existing CLI conventions:
// `--json` on read verbs, exit codes per `headless.ts:9-10`, lazy
// profile resolution via `resolveProfile`.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import {
  EngineClient,
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  type FileWire,
  MAX_INLINE_BYTES,
} from "../engine-client.ts";
import { renderSuspiciousCodepoints, sanitizePathInput } from "../lib/path-input.ts";
import { detectMime } from "../utils/mime.ts";
import {
  readableFromBytes,
  renderProgressLine,
  type UploadProgressEvent,
} from "../utils/upload-progress.ts";

// ---------- Shared helpers ----------

function makeClient(): EngineClient {
  const { engine_url, api_key, active_tenant_id } = resolveProfile();
  return new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
}

function reportError(err: unknown): never {
  process.stderr.write(`${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(exitCodeFor(err));
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Parse `<resource_type>:<uuid>` — used by --link-to and --linked-to.
 *  Validates the resource_type against the engine's enum so a typo
 *  fails locally instead of at the wire boundary.
 *
 *  Exported so the command-layer guard can be exercised directly from
 *  unit tests without spinning up the engine — the unknown-resource-
 *  type rejection path is a public contract surface even though the
 *  helper itself is local to this module. */
export function parseResourceRef(s: string): {
  resource_type: FileLinkResourceType;
  resource_id: string;
} {
  const colon = s.indexOf(":");
  if (colon < 0) {
    throw new Error(`bad resource ref '${s}': expected '<type>:<id>'`);
  }
  const t = s.slice(0, colon);
  const id = s.slice(colon + 1);
  if (!(FILE_LINK_RESOURCE_TYPES as readonly string[]).includes(t)) {
    throw new Error(
      `bad resource_type '${t}': must be one of ${FILE_LINK_RESOURCE_TYPES.join(", ")}`,
    );
  }
  return { resource_type: t as FileLinkResourceType, resource_id: id };
}

interface UploadProgressOpts {
  quiet: boolean;
  json: boolean;
}

/** Render an `UploadProgressEvent` to the right surface.
 *
 *  - `--quiet` or `--json`: silent. `--json` on `sk files upload` is a
 *    single-row output contract (the final `FileWire` printed by
 *    `printJson(row)`); interleaving progress events with the row
 *    breaks every downstream `JSON.parse` consumer including the e2e
 *    `parseJson` harness. Scripted streaming callers that want
 *    per-chunk events should consume the engine's SSE notifications,
 *    not the CLI's stdout.
 *  - Otherwise overwrite-in-place on TTY stderr. */
function renderProgress(ev: UploadProgressEvent, opts: UploadProgressOpts): void {
  if (opts.quiet || opts.json) return;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r${renderProgressLine(ev)}`);
  }
}

/** Final newline after a TTY progress line — silent on --quiet/--json. */
function finishProgress(opts: UploadProgressOpts): void {
  if (opts.quiet || opts.json) return;
  if (process.stderr.isTTY) process.stderr.write("\n");
}

/** Upload a local path, picking inline or presigned-PUT based on size.
 *  Returns the resulting `FileWire` row. Shared by the `upload` /
 *  `attach` verbs and (later) the rewired knowledge / discovery /
 *  workflow / headless flows.
 *
 *  `opts.onProgress` is invoked once per uploaded chunk during the
 *  presigned PUT phase. Callers that want a custom UX (e.g. the Ink
 *  REPL's status line) pass this in lieu of `quiet`/`json` so they
 *  can route the cumulative event into their own renderer without
 *  having stderr scribbled on. */
export async function uploadPath(
  client: EngineClient,
  rawFilePath: string,
  opts: {
    content_type?: string;
    dedup?: boolean;
    quiet?: boolean;
    json?: boolean;
    onProgress?: (ev: UploadProgressEvent) => void;
  } = {},
): Promise<FileWire> {
  // Single chokepoint for *every* file-upload surface (Ink `/attach`,
  // Ink `/knowledge`, `sk file upload`, `sk file attach`, `sk
  // knowledge-sources create`). Stripping invisible Unicode here means
  // copy-paste from any source (Slack, Markdown, browser) survives —
  // see lib/path-input.ts for the offending codepoints. The original
  // string is preserved in errors via `renderSuspiciousCodepoints`.
  const filePath = sanitizePathInput(rawFilePath);
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${rawFilePath}${renderSuspiciousCodepoints(rawFilePath)}`);
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`not a file: ${filePath}`);
  }
  const filename = basename(filePath);
  const content_type = opts.content_type ?? detectMime(filePath);
  const progress: UploadProgressOpts = {
    quiet: opts.quiet ?? false,
    json: opts.json ?? false,
  };

  // Routing decision is invisible to the user. The 5 MB threshold
  // mirrors the engine's MAX_INLINE_BYTES; above it we go presigned.
  if (st.size <= MAX_INLINE_BYTES) {
    const bytes = readFileSync(filePath);
    const content_base64 = bytes.toString("base64");
    return await client.uploadInline({ filename, content_type, content_base64 });
  }

  // Presigned path: batch-create → PUT → finalize. The sha256 is
  // computed up-front so the engine can dedup on the request rather
  // than re-hashing on finalize.
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const batch = await client.batchCreateFiles({
    files: [
      {
        filename,
        content_type,
        size_bytes: bytes.byteLength,
        sha256,
      },
    ],
  });
  const entry = batch.files[0];
  if (!entry) throw new Error("batch-create returned no entries");
  if (entry.dedup) {
    // Engine recognised an existing file by sha256 — no upload needed.
    return await client.getFile(entry.id);
  }
  const stream = readableFromBytes(bytes, filename, entry.id, bytes.byteLength, (ev) => {
    renderProgress(ev, progress);
    opts.onProgress?.(ev);
  });
  // The local presign sink rejects chunked transfer-encoding (per
  // engine/files.ts:208). Bun's `fetch` adds `transfer-encoding:
  // chunked` for ReadableStream bodies unless we set `content-length`
  // explicitly. We do so here — the stream length is fixed.
  const headers: Record<string, string> = {
    ...entry.headers,
    "content-length": String(bytes.byteLength),
    "content-type": content_type,
  };
  try {
    await client.putToPresignedUrl(entry.upload_url, headers, stream);
  } finally {
    finishProgress(progress);
  }
  return await client.finalizeFile(entry.id, sha256);
}

// ---------- list ----------

const listCommand = defineCommand({
  meta: { name: "list", description: "List files" },
  args: {
    status: { type: "string", description: "Filter by status (pending|ready|failed|…)" },
    "linked-to": {
      type: "string",
      description: "Filter to files linked to <type>:<id> (e.g. conversation:abc-…)",
    },
    cursor: { type: "string", description: "Pagination cursor" },
    limit: { type: "string", description: "Max rows (1-100)", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const query: {
        status?: string;
        linked_to?: string;
        cursor?: string;
        limit?: number;
      } = { limit: Number(args.limit) };
      if (args.status) query.status = String(args.status);
      if (args["linked-to"]) query.linked_to = String(args["linked-to"]);
      if (args.cursor) query.cursor = String(args.cursor);
      const res = await client.listFiles(query);
      if (args.json) {
        printJson(res);
        return;
      }
      emitList(
        false,
        ["id", "status", "filename", "size_bytes", "content_type", "created_at"],
        res.items as unknown as Record<string, unknown>[],
      );
      if (res.next_cursor) {
        process.stdout.write(`\n${pc.dim(`next: --cursor ${res.next_cursor}`)}\n`);
      }
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- get ----------

const getCommand = defineCommand({
  meta: { name: "get", description: "Show file metadata" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const row = await client.getFile(args.id);
      if (args.json) {
        printJson(row);
        return;
      }
      const lines = [
        `${pc.bold(row.id)}`,
        `  filename     ${row.filename}`,
        `  status       ${row.status}`,
        `  size         ${humanBytes(row.size_bytes)}`,
        `  content_type ${row.content_type ?? "—"}`,
        `  sha256       ${row.sha256 ?? "—"}`,
        `  scan_result  ${row.scan_result ?? "—"}`,
        `  created_at   ${row.created_at}`,
        `  updated_at   ${row.updated_at}`,
      ];
      if (row.deleted_at) lines.push(`  deleted_at   ${row.deleted_at}`);
      process.stdout.write(`${lines.join("\n")}\n`);
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- upload ----------

const uploadCommand = defineCommand({
  meta: {
    name: "upload",
    description: "Upload a file (inline ≤5 MB, presigned-PUT above)",
  },
  args: {
    path: { type: "positional", required: true, description: "Path to file" },
    "content-type": { type: "string", description: "Override detected MIME type" },
    "no-dedup": {
      type: "boolean",
      description: "Skip the client-side sha256 dedup probe (forces an upload)",
      default: false,
    },
    "link-to": {
      type: "string",
      description: "After upload, link the file to <resource_type>:<id>",
    },
    slug: { type: "string", description: "Optional slug for the link" },
    role: { type: "string", description: "Optional role for the link" },
    label: { type: "string", description: "Reserved for future labels (no-op today)" },
    quiet: { type: "boolean", description: "Suppress progress output", default: false },
    json: { type: "boolean", description: "JSON output (also silences progress)", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    const quiet = Boolean(args.quiet);
    const json = Boolean(args.json);
    try {
      const opts: { content_type?: string; quiet?: boolean; json?: boolean } = { quiet, json };
      if (args["content-type"]) opts.content_type = String(args["content-type"]);
      const row = await uploadPath(client, String(args.path), opts);
      if (args["link-to"]) {
        const ref = parseResourceRef(String(args["link-to"]));
        await client.linkFile(row.id, {
          resource_type: ref.resource_type,
          resource_id: ref.resource_id,
          ...(args.slug ? { slug: String(args.slug) } : {}),
          ...(args.role ? { role: String(args.role) } : {}),
        });
      }
      if (json) {
        printJson(row);
        return;
      }
      if (!quiet) {
        process.stdout.write(
          `${pc.green("uploaded")}  ${row.id}  ${row.filename}  (${humanBytes(row.size_bytes)})\n`,
        );
      }
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- download ----------

const downloadCommand = defineCommand({
  meta: { name: "download", description: "Download a file by id" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    output: {
      type: "string",
      description: "Output path (default: ./<filename>, '-' for stdout)",
    },
    quiet: { type: "boolean", description: "Suppress progress output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const dl = await client.downloadFile(args.id);
      const outPath = args.output ? String(args.output) : `./${dl.filename}`;
      if (outPath === "-") {
        // stdout sink — useful for piping into another command.
        const reader = dl.stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) process.stdout.write(value);
        }
        return;
      }
      const sink = createWriteStream(outPath);
      let written = 0;
      const reader = dl.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          sink.write(value);
          written += value.byteLength;
        }
      }
      await new Promise<void>((resolve, reject) => {
        sink.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
      });
      if (!args.quiet) {
        process.stdout.write(
          `${pc.green("downloaded")}  ${dl.filename} -> ${outPath} (${humanBytes(written)})\n`,
        );
      }
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- delete ----------

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Soft-delete a file" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    force: { type: "boolean", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      if (!args.force && process.stdin.isTTY) {
        // Tiny inline confirm to keep `sk files delete` from being a
        // foot-gun. Scripts can pass --force.
        const prompts = await import("@clack/prompts");
        const ok = await prompts.confirm({ message: `delete ${args.id}?`, initialValue: false });
        if (prompts.isCancel(ok) || ok === false) {
          process.stdout.write("cancelled\n");
          return;
        }
      }
      await client.deleteFile(args.id);
      process.stdout.write(`${pc.green("deleted")}  ${args.id}\n`);
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- link ----------

const linkCommand = defineCommand({
  meta: {
    name: "link",
    description: "Attach a file to an owning resource (conversation, knowledge_source, …)",
  },
  args: {
    fid: { type: "positional", required: true, description: "File id (fid_…)" },
    to: {
      type: "string",
      required: true,
      description: "Owning resource as <resource_type>:<id>",
    },
    slug: { type: "string", description: "Optional slug for the link" },
    role: { type: "string", description: "Optional role for the link" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const ref = parseResourceRef(String(args.to));
      const link = await client.linkFile(String(args.fid), {
        resource_type: ref.resource_type,
        resource_id: ref.resource_id,
        ...(args.slug ? { slug: String(args.slug) } : {}),
        ...(args.role ? { role: String(args.role) } : {}),
      });
      printJson(link);
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- stats ----------

const statsCommand = defineCommand({
  meta: { name: "stats", description: "Aggregate file counters for this tenant" },
  args: {
    by: { type: "string", description: "Group by: status|scanner_verdict (default: status)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const stats = await client.getFileStats();
      if (args.json) {
        printJson(stats);
        return;
      }
      const lines: string[] = [];
      lines.push(`total          ${stats.total}`);
      lines.push(`dedup_hits     ${stats.dedup_hits}`);
      const groupBy = (args.by ?? "status").toString();
      lines.push("");
      if (groupBy === "scanner_verdict") {
        lines.push(`${pc.bold("by scanner verdict:")}`);
        for (const [k, v] of Object.entries(stats.scan_verdicts)) {
          lines.push(`  ${k.padEnd(16)} ${v}`);
        }
      } else {
        lines.push(`${pc.bold("by status:")}`);
        for (const [k, v] of Object.entries(stats.by_status)) {
          lines.push(`  ${k.padEnd(16)} ${v}`);
        }
      }
      lines.push("");
      lines.push(`${pc.bold("by size bucket:")}`);
      for (const [k, v] of Object.entries(stats.by_size_bucket)) {
        lines.push(`  ${k.padEnd(16)} ${v}`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    } catch (err) {
      reportError(err);
    }
  },
});

// ---------- Aggregate ----------

export const filesCommand = defineCommand({
  meta: { name: "files", description: "Manage files (upload, download, link, …)" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    upload: uploadCommand,
    download: downloadCommand,
    delete: deleteCommand,
    link: linkCommand,
    stats: statsCommand,
  },
});

// ---------- `sk attach <conversation-id> <path>` shortcut ----------
//
// Equivalent to `sk files upload <path> --link-to conversation:<id>`,
// but takes the conversation id as a leading positional so it reads
// naturally. The result is the FileRow plus the inserted link.

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description: "Upload a file and link it to a conversation (shortcut)",
  },
  args: {
    "conversation-id": {
      type: "positional",
      required: true,
      description: "Conversation id (UUID)",
    },
    path: { type: "positional", required: true, description: "Path to file" },
    "content-type": { type: "string", description: "Override detected MIME type" },
    slug: { type: "string", description: "Optional slug for the link" },
    role: { type: "string", description: "Optional role for the link" },
    quiet: { type: "boolean", description: "Suppress progress output", default: false },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    const quiet = Boolean(args.quiet);
    const json = Boolean(args.json);
    try {
      const opts: { content_type?: string; quiet?: boolean; json?: boolean } = { quiet, json };
      if (args["content-type"]) opts.content_type = String(args["content-type"]);
      const row = await uploadPath(client, String(args.path), opts);
      const link = await client.linkFile(row.id, {
        resource_type: "conversation",
        resource_id: String(args["conversation-id"]),
        ...(args.slug ? { slug: String(args.slug) } : {}),
        ...(args.role ? { role: String(args.role) } : {}),
      });
      if (json) {
        printJson({ file: row, link });
        return;
      }
      if (!quiet) {
        process.stdout.write(
          `${pc.green("attached")}  ${row.id}  ${row.filename}  →  conversation:${args["conversation-id"]}\n`,
        );
      }
    } catch (err) {
      reportError(err);
    }
  },
});
