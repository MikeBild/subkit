import { createHash } from "node:crypto";
import { basename } from "node:path";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import {
  type EngineClient,
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  type FileWire,
  MAX_INLINE_BYTES,
} from "../engine-client.ts";
import {
  catalogMetadataArgs,
  catalogMetadataBody,
  shortDescription,
} from "../lib/catalog-metadata.ts";
import {
  readRegularFile,
  renderSuspiciousCodepoints,
  sanitizePathInput,
} from "../lib/path-input.ts";
import { writeStreamAtomically } from "../utils/atomic-write.ts";
import { detectMime } from "../utils/mime.ts";
import {
  readableFromBytes,
  renderProgressLine,
  type UploadProgressEvent,
} from "../utils/upload-progress.ts";
import { makeClient, withCommandErrors } from "./command-runtime.ts";

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

function renderProgress(ev: UploadProgressEvent, opts: UploadProgressOpts): void {
  if (opts.quiet || opts.json) return;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r${renderProgressLine(ev)}`);
  }
}

function finishProgress(opts: UploadProgressOpts): void {
  if (opts.quiet || opts.json) return;
  if (process.stderr.isTTY) process.stderr.write("\n");
}

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
  const filePath = sanitizePathInput(rawFilePath);
  const read = readRegularFile(filePath);
  if (read.kind === "missing") {
    throw new Error(`file not found: ${rawFilePath}${renderSuspiciousCodepoints(rawFilePath)}`);
  }
  if (read.kind === "not_file") {
    throw new Error(`not a file: ${filePath}`);
  }
  const bytes = read.bytes;
  const filename = basename(filePath);
  const content_type = opts.content_type ?? detectMime(filePath);
  const progress: UploadProgressOpts = {
    quiet: opts.quiet ?? false,
    json: opts.json ?? false,
  };

  if (bytes.byteLength <= MAX_INLINE_BYTES) {
    const content_base64 = bytes.toString("base64");
    return await client.uploadInline({ filename, content_type, content_base64 });
  }

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
    return await client.getFile(entry.id);
  }
  const stream = readableFromBytes(bytes, filename, entry.id, bytes.byteLength, (ev) => {
    renderProgress(ev, progress);
    opts.onProgress?.(ev);
  });
  const headers: Record<string, string> = {
    ...entry.headers,
    "content-length": String(bytes.byteLength),
    "content-type": content_type,
  };
  try {
    await client.putUploadBytes(entry.upload_url, headers, stream);
  } finally {
    finishProgress(progress);
  }
  return await client.finalizeFile(entry.id, sha256);
}

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
    return withCommandErrors(
      async () => {
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
          ["id", "status", "filename", "category", "description", "size_bytes", "created_at"],
          (res.items as unknown as Record<string, unknown>[]).map((r) => ({
            ...r,
            description: shortDescription(r.description),
          })),
        );
        if (res.next_cursor) {
          process.stdout.write(`\n${pc.dim(`next: --cursor ${res.next_cursor}`)}\n`);
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Show file metadata" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
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
      },
      { json: Boolean(args.json) },
    );
  },
});

export async function runFileUpload(
  client: EngineClient,
  uploadArgs: {
    path: string;
    contentType?: string;
    linkTo?: string;
    slug?: string;
    role?: string;
    quiet: boolean;
    json: boolean;
  },
): Promise<FileWire> {
  const linkRef = uploadArgs.linkTo ? parseResourceRef(uploadArgs.linkTo) : undefined;
  const row = await uploadPath(client, uploadArgs.path, {
    quiet: uploadArgs.quiet,
    json: uploadArgs.json,
    ...(uploadArgs.contentType ? { content_type: uploadArgs.contentType } : {}),
  });
  if (linkRef) {
    await client.linkFile(row.id, {
      ...linkRef,
      ...(uploadArgs.slug ? { slug: uploadArgs.slug } : {}),
      ...(uploadArgs.role ? { role: uploadArgs.role } : {}),
    });
  }
  return row;
}

const uploadCommand = defineCommand({
  meta: {
    name: "upload",
    description: "Upload a file (inline ≤5 MB, authenticated streaming above)",
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
    return withCommandErrors(
      async () => {
        const row = await runFileUpload(client, {
          path: String(args.path),
          quiet,
          json,
          ...(args["content-type"] ? { contentType: String(args["content-type"]) } : {}),
          ...(args["link-to"] ? { linkTo: String(args["link-to"]) } : {}),
          ...(args.slug ? { slug: String(args.slug) } : {}),
          ...(args.role ? { role: String(args.role) } : {}),
        });
        if (json) {
          printJson(row);
          return;
        }
        if (!quiet) {
          process.stdout.write(
            `${pc.green("uploaded")}  ${row.id}  ${row.filename}  (${humanBytes(row.size_bytes)})\n`,
          );
        }
      },
      { json: Boolean(args.json) },
    );
  },
});

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
    return withCommandErrors(async () => {
      const dl = await client.downloadFile(args.id);
      const outPath = args.output ? String(args.output) : `./${dl.filename}`;
      if (outPath === "-") {
        const reader = dl.stream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) process.stdout.write(value);
        }
        return;
      }
      const written = await writeStreamAtomically(dl.stream, outPath, {
        expectedBytes: dl.size_bytes,
      });
      if (!args.quiet) {
        process.stdout.write(
          `${pc.green("downloaded")}  ${dl.filename} -> ${outPath} (${humanBytes(written)})\n`,
        );
      }
    });
  },
});

const replaceCommand = defineCommand({
  meta: {
    name: "replace",
    description: `Replace a file's content (up to ${MAX_INLINE_BYTES / 1024 / 1024} MB); the id, reference and earlier versions stay`,
  },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    path: { type: "positional", required: true, description: "Path to the new content" },
    "content-type": { type: "string", description: "Override detected MIME type" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const filePath = sanitizePathInput(String(args.path));
        const read = readRegularFile(filePath);
        if (read.kind !== "file") {
          throw new Error(
            `file not found: ${String(args.path)}${renderSuspiciousCodepoints(String(args.path))}`,
          );
        }
        const bytes = read.bytes;
        if (bytes.byteLength > MAX_INLINE_BYTES) {
          throw new Error(`replacement content is larger than ${humanBytes(MAX_INLINE_BYTES)}`);
        }
        const row = await client.replaceFile(String(args.id), {
          filename: basename(filePath),
          content_type: args["content-type"] ? String(args["content-type"]) : detectMime(filePath),
          content_base64: bytes.toString("base64"),
        });
        if (args.json) {
          printJson(row);
          return;
        }
        process.stdout.write(
          `${pc.green("replaced")}  ${row.id}  ${row.filename}  (${humanBytes(row.size_bytes)})\n`,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const versionsCommand = defineCommand({
  meta: { name: "versions", description: "List a file's current and earlier content versions" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const items = await client.listFileVersions(String(args.id));
        if (args.json) {
          printJson({ items });
          return;
        }
        const lines = items.map((item) => {
          const label = `v${item.version}`.padEnd(5);
          const marker = item.current ? pc.green("current ") : "        ";
          const origin = item.restored_from ? pc.dim(` restored from v${item.restored_from}`) : "";
          return `${label} ${marker} ${item.uploaded_at}  ${humanBytes(item.size_bytes).padStart(9)}  ${item.filename}${origin}`;
        });
        process.stdout.write(`${lines.join("\n")}\n`);
      },
      { json: Boolean(args.json) },
    );
  },
});

const restoreCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Make an earlier content version current again as a new version",
  },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    version: { type: "positional", required: true, description: "Version number to restore" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const version = Number(args.version);
        if (!Number.isInteger(version) || version < 1) {
          throw new Error("version must be a positive whole number");
        }
        const row = await client.restoreFileVersion(String(args.id), version);
        if (args.json) {
          printJson(row);
          return;
        }
        process.stdout.write(`${pc.green("restored")}  ${row.id}  v${version}  ${row.filename}\n`);
      },
      { json: Boolean(args.json) },
    );
  },
});

export async function runFileDelete(deps: {
  id: string;
  force: boolean;
  isTTY: boolean;
  deleteFile: (id: string) => Promise<unknown>;
  confirm: (message: string) => Promise<boolean>;
  writeOut: (text: string) => void;
  writeErr: (text: string) => void;
}): Promise<number> {
  if (!deps.force) {
    if (!deps.isTTY) {
      deps.writeErr(
        `error: refusing to delete ${deps.id} without confirmation. Re-run with --force to confirm.\n`,
      );
      return 2;
    }
    if (!(await deps.confirm(`delete ${deps.id}?`))) {
      deps.writeOut("cancelled\n");
      return 0;
    }
  }
  await deps.deleteFile(deps.id);
  deps.writeOut(`${pc.green("deleted")}  ${deps.id}\n`);
  return 0;
}

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Soft-delete a file" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    force: { type: "boolean", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    const exitCode = await withCommandErrors(() =>
      runFileDelete({
        id: String(args.id),
        force: Boolean(args.force),
        isTTY: Boolean(process.stdin.isTTY),
        deleteFile: (id) => client.deleteFile(id),
        confirm: async (message) => {
          const prompts = await import("@clack/prompts");
          const ok = await prompts.confirm({ message, initialValue: false });
          return !prompts.isCancel(ok) && ok === true;
        },
        writeOut: (text) => process.stdout.write(text),
        writeErr: (text) => process.stderr.write(text),
      }),
    );
    if (exitCode) process.exit(exitCode);
  },
});

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
    return withCommandErrors(async () => {
      const ref = parseResourceRef(String(args.to));
      const link = await client.linkFile(String(args.fid), {
        resource_type: ref.resource_type,
        resource_id: ref.resource_id,
        ...(args.slug ? { slug: String(args.slug) } : {}),
        ...(args.role ? { role: String(args.role) } : {}),
      });
      printJson(link);
    });
  },
});

const statsCommand = defineCommand({
  meta: { name: "stats", description: "Aggregate file counters for this tenant" },
  args: {
    by: { type: "string", description: "Group by: status|scanner_verdict (default: status)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
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
      },
      { json: Boolean(args.json) },
    );
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Rename a file or change its description or category" },
  args: {
    id: { type: "positional", required: true, description: "File id (fid_…)" },
    filename: { type: "string", description: "New filename" },
    ...catalogMetadataArgs,
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    return withCommandErrors(
      async () => {
        const body: Record<string, unknown> = { ...catalogMetadataBody(args) };
        if (args.filename) body.filename = args.filename;
        if (Object.keys(body).length === 0) {
          throw new Error("pass at least one of --filename, --description, --category");
        }
        printJson(await client.patchFile(args.id, body));
      },
      { json: Boolean(args.json) },
    );
  },
});

export const filesCommand = defineCommand({
  meta: { name: "files", description: "Manage files (upload, download, link, …)" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    upload: uploadCommand,
    download: downloadCommand,
    replace: replaceCommand,
    versions: versionsCommand,
    restore: restoreCommand,
    delete: deleteCommand,
    link: linkCommand,
    patch: patchCommand,
    stats: statsCommand,
  },
});

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
    return withCommandErrors(
      async () => {
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
      },
      { json: Boolean(args.json) },
    );
  },
});
