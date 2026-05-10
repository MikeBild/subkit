// Knowledge tab — list of tenant knowledge sources with inline ingest,
// delete, and refresh. G8 closure of #159 M7: ingest is no longer
// CLI-only; pressing `i` opens an inline path-input that reads the
// file from disk and POSTs via createKnowledgeSource.
//
// Path resolution: the typed value is treated as either an absolute
// path or a path relative to the current cwd. Drag-and-drop on
// terminals that paste the absolute path also works. Mime type is
// guessed from the file extension; unknown extensions fall back to
// `application/octet-stream`.

import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { ConsentPrompt } from "../../repl/components/ConsentPrompt.tsx";
import { checkIngestGuard } from "../lib/knowledge-ingest-guard.ts";

const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".html": "text/html",
  ".csv": "text/csv",
});

function mimeFor(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

interface Props {
  client: EngineClient;
  onSearchActiveChange?: (active: boolean) => void;
}

interface SourceRow {
  id: string;
  name: string;
  status: string;
  lastIndexed: string | null;
}

function pickName(raw: Record<string, unknown>): string {
  if (typeof raw.name === "string") return raw.name;
  if (typeof raw.title === "string") return raw.title;
  if (typeof raw.uri === "string") return raw.uri;
  return typeof raw.id === "string" ? raw.id : "(unnamed)";
}

function pickStatus(raw: Record<string, unknown>): string {
  if (typeof raw.status === "string") return raw.status;
  if (typeof raw.state === "string") return raw.state;
  return "unknown";
}

function pickLastIndexed(raw: Record<string, unknown>): string | null {
  for (const key of ["last_indexed_at", "indexed_at", "updated_at"]) {
    const v = raw[key];
    if (typeof v === "string") return v;
  }
  return null;
}

export const KnowledgeTab: React.FC<Props> = ({ client, onSearchActiveChange }) => {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listIdx, setListIdx] = useState(0);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SourceRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionFlash, setActionFlash] = useState<string | null>(null);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestPath, setIngestPath] = useState("");
  const [ingesting, setIngesting] = useState(false);

  useEffect(() => {
    onSearchActiveChange?.(searchActive || searchQuery.length > 0);
  }, [searchActive, searchQuery, onSearchActiveChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await client.listKnowledgeSources();
        if (cancelled) return;
        const next: SourceRow[] = res.items.map((it) => ({
          id: typeof it.id === "string" ? it.id : "(unknown)",
          name: pickName(it),
          status: pickStatus(it),
          lastIndexed: pickLastIndexed(it),
        }));
        setRows(next);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  const filtered = useMemo(() => {
    if (!searchQuery) return rows;
    const q = searchQuery.toLowerCase();
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  }, [rows, searchQuery]);

  const submitIngest = async (): Promise<void> => {
    if (!ingestPath.trim()) return;
    setIngesting(true);
    setActionFlash(null);
    try {
      const abs = isAbsolute(ingestPath) ? ingestPath : resolve(process.cwd(), ingestPath);
      // W6 of PR #161 review (round 6): UX guard lifted to
      // `lib/knowledge-ingest-guard.ts` so the contract is unit-
      // testable and a future widening of the deny-list cannot
      // drift past the test suite. The guard covers both Unix
      // (/etc /proc /sys /var /dev /root + ~/.ssh ~/.aws ~/.gnupg
      // ~/.kube ~/.docker ~/.config ~/.sk) and Windows
      // (C:\Windows, C:\Program Files, AppData, ~/.ssh) — earlier
      // round-4 guard was Linux-only and missed credentials roots.
      const stats = await stat(abs);
      const guard = checkIngestGuard({ absolutePath: abs, sizeBytes: stats.size });
      if (guard.rejected) {
        setActionFlash(guard.reason ?? "ingest refused");
        return;
      }
      // S-2 of PR #161 review (round 3): async read so a multi-MB
      // knowledge source (PDFs, large docs) doesn't hitch the Ink
      // render thread while the file is being slurped from disk. The
      // surrounding state (`ingesting`) already drives the spinner.
      const content = await readFile(abs);
      const name = abs.split("/").pop() ?? ingestPath;
      const mime = mimeFor(name);
      await client.createKnowledgeSource(
        { name, content, mime_type: mime },
        { source: "sk-cli /settings → Knowledge tab" },
      );
      setActionFlash(`ingested ${name} (${content.length} bytes, ${mime})`);
      setIngestPath("");
      setIngestOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setActionFlash(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIngesting(false);
    }
  };

  useInput((input, key) => {
    if (ingesting) return;
    if (ingestOpen) {
      if (key.escape) {
        setIngestOpen(false);
        setIngestPath("");
        return;
      }
      if (key.return) {
        void submitIngest();
        return;
      }
      if (key.backspace || key.delete) {
        setIngestPath((p) => p.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setIngestPath((p) => p + input);
        return;
      }
      return;
    }
    if (pendingDelete) return;
    if (searchActive) {
      if (key.escape) {
        setSearchQuery("");
        setSearchActive(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearchQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input !== "/") {
        setSearchQuery((q) => q + input);
        return;
      }
      return;
    }
    if (input === "/") {
      setSearchActive(true);
      return;
    }
    if (key.upArrow) {
      setListIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setListIdx((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (input === "d") {
      const sel = filtered[listIdx];
      if (sel) setPendingDelete(sel);
      return;
    }
    if (input === "i") {
      setIngestOpen(true);
      return;
    }
    if (input === "r") {
      setRefreshKey((k) => k + 1);
      return;
    }
  });

  const onConfirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    try {
      await client.deleteKnowledgeSource(pendingDelete.id);
      setActionFlash(`deleted ${pendingDelete.name}`);
      setRows((prev) => prev.filter((r) => r.id !== pendingDelete.id));
    } catch (err) {
      setActionFlash(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setPendingDelete(null);
  };

  return (
    <Box flexDirection="column">
      <Text bold>Knowledge sources</Text>
      <Box>
        <Text color="gray">↑/↓ navigate · / filter · i ingest · d delete · r refresh</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {actionFlash ? <Text color="cyan">{actionFlash}</Text> : null}
        {!loading && !error && filtered.length === 0 ? (
          <Text color="gray">
            {searchQuery ? `no sources match "${searchQuery}"` : "no knowledge sources"}
          </Text>
        ) : null}
        {filtered.map((r, i) => (
          <Box key={r.id}>
            <Text color={i === listIdx ? "cyan" : "white"}>{i === listIdx ? "› " : "  "}</Text>
            <Text>{r.name}</Text>
            <Text color="gray"> [{r.status}]</Text>
            {r.lastIndexed ? <Text color="gray"> · {r.lastIndexed}</Text> : null}
          </Box>
        ))}
      </Box>
      {ingestOpen ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold>Ingest knowledge source</Text>
          <Text color="gray">
            Paste an absolute path or one relative to your current cwd. Enter to ingest, Esc to
            cancel.
          </Text>
          <Box marginTop={1}>
            <Text color="cyan">path: </Text>
            <Text>{ingestPath}</Text>
            {!ingesting ? <Text inverse> </Text> : null}
          </Box>
          {ingesting ? (
            <Box marginTop={1}>
              <Text color="gray">uploading…</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {pendingDelete ? (
        <Box marginTop={1}>
          <ConsentPrompt
            title={`Delete "${pendingDelete.name}"?`}
            body="This removes the source and all of its indexed chunks. Cannot be undone."
            yesLabel="Delete"
            noLabel="Cancel"
            onYes={onConfirmDelete}
            onNo={() => setPendingDelete(null)}
          />
        </Box>
      ) : null}
    </Box>
  );
};
