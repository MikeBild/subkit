import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { AdminCreateForm, type AdminFormField } from "./AdminCreateForm.tsx";

interface Props {
  title: string;
  cliHint?: string;
  fetcher: () => Promise<{ items: Record<string, unknown>[] }>;
  rowLabel?: (raw: Record<string, unknown>) => string;
  createForm?: {
    title: string;
    fields: readonly AdminFormField[];
    submit: (values: Record<string, string>) => Promise<void>;
  };
  onInnerEscape?: (active: boolean) => void;
}

function defaultRowLabel(raw: Record<string, unknown>): string {
  for (const key of ["name", "title", "slug", "id"]) {
    const v = raw[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "(unnamed)";
}

export const GenericListSubTab: React.FC<Props> = ({
  title,
  cliHint,
  fetcher,
  rowLabel,
  createForm,
  onInnerEscape,
}) => {
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionFlash, setActionFlash] = useState<string | null>(null);

  useEffect(() => {
    onInnerEscape?.(createOpen);
  }, [createOpen, onInnerEscape]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcher()
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, refreshKey]);

  useInput((input) => {
    if (createOpen) return;
    if (input === "c" && createForm) {
      setCreateOpen(true);
    }
  });

  const label = rowLabel ?? defaultRowLabel;

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {createForm ? <Text color="gray">c create</Text> : null}
      {cliHint ? <Text color="gray">CLI: {cliHint}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {actionFlash ? <Text color="cyan">{actionFlash}</Text> : null}
        {!loading && !error && items.length === 0 ? <Text color="gray">no entries</Text> : null}
        {items.map((it, i) => (
          <Box key={typeof it.id === "string" ? it.id : `row-${i}`}>
            <Text color="gray">· </Text>
            <Text>{label(it)}</Text>
          </Box>
        ))}
      </Box>
      {createOpen && createForm ? (
        <Box marginTop={1}>
          <AdminCreateForm
            title={createForm.title}
            fields={createForm.fields}
            onSubmit={async (vals) => {
              await createForm.submit(vals);
              setCreateOpen(false);
              setActionFlash(`created ${createForm.title.toLowerCase()}`);
              setRefreshKey((k) => k + 1);
            }}
            onCancel={() => setCreateOpen(false)}
          />
        </Box>
      ) : null}
    </Box>
  );
};
