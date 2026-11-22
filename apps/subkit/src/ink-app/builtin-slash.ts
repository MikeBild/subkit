import type React from "react";
import { uploadPath } from "../commands/files.ts";
import type { KnowledgeSourceMetadata } from "../engine-client/knowledge.ts";
import type { EngineClient } from "../engine-client.ts";
import {
  readRegularFile,
  renderSuspiciousCodepoints,
  sanitizePathInput,
} from "../lib/path-input.ts";
import { readClipboard } from "../repl/clipboard-read.ts";
import type { PasteStore } from "../repl/paste-store.ts";
import type { CommandQueue } from "../repl/queue.ts";
import type { PaneSpec } from "../repl/slash/handler.ts";
import { renderProgressLine, type UploadProgressEvent } from "../utils/upload-progress.ts";
import type { TranscriptMode } from "./types.ts";

interface BuiltinSlashContext {
  engineClient: EngineClient | undefined;
  cwd: string | undefined;
  conversationId: string | null;
  historyPath: string;
  transcriptMode: TranscriptMode;
  pasteStoreRef: React.MutableRefObject<PasteStore>;
  queue: CommandQueue;
  recentLists: Map<string, unknown[]>;
  historyRef: React.MutableRefObject<string[]>;
  historyCursorRef: React.MutableRefObject<number>;
  insertText: (text: string) => void;
  setPane: (spec: PaneSpec) => void;
  setTranscriptMode: (mode: TranscriptMode) => void;
  openLauncher: () => void;
  syncPendingPasteRefs: () => void;
  setTransientStatus: (msg: string | null) => void;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
}

export async function runBuiltinSlash(trimmed: string, ctx: BuiltinSlashContext): Promise<boolean> {
  const {
    engineClient,
    cwd,
    conversationId,
    historyPath: effectiveHistoryPath,
    transcriptMode,
    pasteStoreRef,
    queue,
    recentLists,
    historyRef,
    historyCursorRef,
    insertText,
    setPane,
    setTranscriptMode,
    openLauncher,
    syncPendingPasteRefs,
    setTransientStatus,
    showInfo,
    showError,
  } = ctx;
  const [head, ...rest] = trimmed.split(/\s+/);
  const name = (head ?? "").replace(/^\//, "");
  const mutatePendingPaste = (): boolean => {
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub !== "clear" && sub !== "remove" && sub !== "rm") return false;
    if (sub === "clear") {
      const count = pasteStoreRef.current.all().length;
      pasteStoreRef.current.clear();
      syncPendingPasteRefs();
      showInfo(`/paste: cleared ${count} pending item(s)`);
      return true;
    }
    const rawId = rest[1];
    const id = Number.parseInt(rawId ?? "", 10);
    if (!Number.isFinite(id)) {
      showError("/paste: usage `/paste remove <id>`");
      return true;
    }
    if (!pasteStoreRef.current.get(id)) {
      showError(`/paste: no pending item #${id}`);
      return true;
    }
    pasteStoreRef.current.delete(id);
    syncPendingPasteRefs();
    showInfo(`/paste: removed #${id}`);
    return true;
  };
  if (name === "paste") {
    if (mutatePendingPaste()) return true;
    const clip = readClipboard();
    if (clip.kind === "none") {
      showInfo("/paste: clipboard is empty");
      return true;
    }
    if (clip.kind === "text") {
      const { ref, lines } = pasteStoreRef.current.addText(clip.text);
      syncPendingPasteRefs();
      insertText(ref);
      showInfo(`/paste: inserted ${ref} (${lines + 1} line${lines === 0 ? "" : "s"})`);
      return true;
    }
    const img = pasteStoreRef.current.addImage({
      path: clip.path,
      mediaType: clip.mediaType,
      bytes: clip.bytes,
    });
    syncPendingPasteRefs();
    insertText(img.ref);
    showInfo(`/paste: inserted ${img.ref} (${clip.bytes} bytes)`);
    return true;
  }
  if (name === "knowledge" || name === "ks") {
    if (!engineClient) {
      showError(`/${name}: no engine client — restart subkit to wire the upload path`);
      return true;
    }
    const flagStart = rest.findIndex((t) => t.startsWith("--"));
    const pathTokens = flagStart === -1 ? rest : rest.slice(0, flagStart);
    const flagTokens = flagStart === -1 ? [] : rest.slice(flagStart);
    const rawPath = sanitizePathInput(pathTokens.join(" "));
    if (rawPath.length === 0) {
      showError(
        `/${name}: needs a path — e.g. \`/${name} ./ocpp.md --name OCPP-2.0.1 --scope global\``,
      );
      return true;
    }
    const flagMap: Record<string, string> = {};
    for (let i = 0; i < flagTokens.length; i++) {
      const tok = flagTokens[i] ?? "";
      if (!tok.startsWith("--")) continue;
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        flagMap[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = flagTokens[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flagMap[key] = next;
          i += 1;
        } else {
          flagMap[key] = "true";
        }
      }
    }
    const overrideName = flagMap.name;
    const scope = flagMap.scope;
    const workflow_id = flagMap["workflow-id"];
    if (scope && scope !== "global" && scope !== "workflow") {
      showError(`/${name}: --scope must be 'global' or 'workflow' (got '${scope}')`);
      return true;
    }
    if (scope === "workflow" && !workflow_id) {
      showError(`/${name}: --scope workflow requires --workflow-id <uuid>`);
      return true;
    }
    const { resolve: res, basename: pathBasename } = await import("node:path");
    const abs = res(cwd ?? process.cwd(), rawPath);
    const read = readRegularFile(abs);
    if (read.kind === "missing") {
      showError(
        `/${name}: not found: ${rawPath} (resolved to ${abs})${renderSuspiciousCodepoints(rawPath)}`,
      );
      return true;
    }
    if (read.kind === "not_file") {
      showError(`/${name}: not a file: ${rawPath}`);
      return true;
    }
    const bytes = read.bytes;
    const onProgress = (ev: UploadProgressEvent): void => {
      setTransientStatus(renderProgressLine(ev));
    };
    try {
      const row = await uploadPath(engineClient, abs, {
        quiet: true,
        onProgress,
      });
      const { detectMime } = await import("../utils/mime.ts");
      const filename = pathBasename(abs);
      const mime_type = detectMime(abs);
      const ksName = overrideName ?? (filename.replace(/\.[^.]+$/, "") || filename);
      const metadata: KnowledgeSourceMetadata = { name: ksName };
      if (scope === "global" || scope === "workflow") metadata.scope = scope;
      if (workflow_id) metadata.workflow_id = workflow_id;
      const ks = (await engineClient.createKnowledgeSource(
        { name: filename, content: bytes, mime_type },
        metadata,
      )) as { id?: string; chunk_count?: number; scope?: string; name?: string };
      if (conversationId) {
        try {
          await engineClient.linkFile(row.id, {
            resource_type: "conversation",
            resource_id: conversationId,
            role: "attachment",
          });
        } catch {}
      }
      const ksId = ks.id ?? "?";
      const chunks = ks.chunk_count ?? 0;
      const reportedScope = ks.scope ?? scope ?? "global";
      const reportedName = ks.name ?? ksName;
      showInfo(`✓ ingested ${ksId} — ${chunks} chunks, ${reportedScope} (${reportedName})`);
    } catch (err) {
      showError(`/${name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTransientStatus(null);
    }
    return true;
  }
  if (name === "queue") {
    const items = [...queue.items];
    if (items.length === 0) showInfo("/queue: empty");
    else showInfo(`/queue: ${items.length} pending — ${items.slice(0, 3).join(" ; ")}`);
    return true;
  }
  if (name === "files") {
    if (!engineClient) {
      showError("/files: no engine client — restart subkit to enable file browsing");
      return true;
    }
    if (!conversationId) {
      showError("/files: no active conversation yet — type a prompt first");
      return true;
    }
    const cacheKey = `files:${conversationId}`;
    type FileRow = { id: string; filename: string; size_bytes: number; status: string };
    const cached = recentLists.get(cacheKey) as FileRow[] | undefined;
    const pickArg = rest[0];
    if (pickArg && cached && /^\d+$/.test(pickArg)) {
      const idx = Number.parseInt(pickArg, 10) - 1;
      const row = cached[idx];
      if (!row) {
        showError(`/files: no row #${pickArg} in the last listing`);
        return true;
      }
      const mention = `@file:${row.id}`;
      insertText(mention);
      showInfo(`/files: inserted ${mention} (${row.filename})`);
      return true;
    }
    try {
      const res = await engineClient.listFiles({
        linked_to: `conversation:${conversationId}`,
        limit: 50,
      });
      if (res.items.length === 0) {
        showInfo(
          "/files: no files linked to this conversation yet — paste or drop a file path into the composer",
        );
        return true;
      }
      const rows: FileRow[] = res.items.map((f) => ({
        id: f.id,
        filename: f.filename,
        size_bytes: f.size_bytes,
        status: f.status,
      }));
      recentLists.set(cacheKey, rows);
      const lines = rows.map(
        (r, i) =>
          `${(i + 1).toString().padStart(2)}.  ${r.id}  ${r.filename}  (${r.size_bytes} B, ${r.status})`,
      );
      lines.push("");
      lines.push("type `/files <n>` to insert an @file:fid_... mention at the cursor");
      setPane({
        kind: "text",
        title: "files",
        subtitle: `${rows.length} linked to this conversation`,
        lines,
      });
    } catch (err) {
      showError(`/files: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }
  if (name === "history") {
    const sub = rest[0];
    if (sub === "clear") {
      const { clearHistory } = await import("../repl/history-store.ts");
      clearHistory(effectiveHistoryPath);
      historyRef.current = [];
      historyCursorRef.current = 0;
      showInfo("/history: cleared");
      return true;
    }
    showInfo(`/history: ${historyRef.current.length} prompt(s) stored at ${effectiveHistoryPath}`);
    return true;
  }
  if (name === "view") {
    const sub = (rest[0] ?? "").toLowerCase();
    if (!sub) {
      showInfo(`/view: ${transcriptMode}`);
      return true;
    }
    if (sub !== "chat" && sub !== "inspect") {
      showError("/view: use `/view chat` or `/view inspect`");
      return true;
    }
    setTranscriptMode(sub);
    showInfo(`/view: ${sub}`);
    return true;
  }
  if (name === "actions" || name === "tasks") {
    openLauncher();
    return true;
  }
  return false;
}
