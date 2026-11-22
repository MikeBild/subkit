import { isEngineError } from "@cli-core/errors.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { EngineClient } from "../../engine-client.ts";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { FieldEditor } from "../components/FieldEditor.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { SettingItem } from "../components/SettingItem.tsx";
import {
  PersonalityPicker,
  StatuslineConfigurator,
  ThemePicker,
  TitleConfigurator,
} from "../components/ValuePickers.tsx";
import { resolveAction } from "../keybindings/useKeybinding.ts";
import { labelForPath, sectionLabel } from "../lib/config-labels.ts";
import { type FormField, leafToFormField } from "../lib/zod-to-form-fields.ts";

type PickerProps = {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
};
const PICKER_REGISTRY: Readonly<Record<string, React.FC<PickerProps>>> = {
  "ui.theme": ThemePicker,
  "ui.personality": PersonalityPicker,
  "ui.title.format": TitleConfigurator,
  "ui.statusline.format": StatuslineConfigurator,
};

interface Props {
  fields: FormField[];
  tenant?: string;
  client: EngineClient;
  onInnerEscape?: (active: boolean) => void;
}

interface PendingRestart {
  field: FormField;
  value: unknown;
  message: string;
}

function isRestartRequiredError(err: unknown): { message: string } | null {
  if (isEngineError(err) && err.code === "restart_required") {
    return { message: err.message };
  }
  return null;
}

const WINDOW_ROWS = 12;

function pickWindow(total: number, idx: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  const half = Math.floor(size / 2);
  let start = Math.max(0, idx - half);
  const end = Math.min(total, start + size);
  start = Math.max(0, end - size);
  return { start, end };
}

function pickDescription(field: FormField): string {
  return field.description ?? "(no description in engine schema)";
}

export const ConfigTab: React.FC<Props> = ({
  fields: initialFields,
  tenant,
  client,
  onInnerEscape,
}) => {
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [listIdx, setListIdx] = useState(0);
  const [editing, setEditing] = useState<FormField | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [flash, setFlash] = useState<{ kind: "info" | "error" | "ok"; msg: string } | null>(null);

  useLayoutEffect(() => {
    const ownsEsc =
      searchActive || searchQuery.length > 0 || editing !== null || pendingRestart !== null;
    onInnerEscape?.(ownsEsc);
  }, [searchActive, searchQuery, editing, pendingRestart, onInnerEscape]);

  const filtered = useMemo(() => {
    if (!searchQuery) return fields;
    const q = searchQuery.toLowerCase();
    return fields.filter((f) => {
      if (f.path.toLowerCase().includes(q)) return true;
      if (labelForPath(f.path).toLowerCase().includes(q)) return true;
      return (f.description ?? "").toLowerCase().includes(q);
    });
  }, [fields, searchQuery]);

  useEffect(() => {
    if (listIdx > Math.max(0, filtered.length - 1)) setListIdx(0);
  }, [filtered.length, listIdx]);

  useInput((input, key) => {
    if (editing || pendingRestart) return;
    if (searchActive) {
      const action = resolveAction("Search", input, key);
      if (action === "search:clear") {
        setSearchQuery("");
        setSearchActive(false);
        return;
      }
      if (action === "list:edit") {
        const sel = filtered[listIdx];
        if (sel) setEditing(sel);
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
    const action = resolveAction("Settings", input, key);
    switch (action) {
      case "list:next":
        setListIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      case "list:prev":
        setListIdx((i) => Math.max(0, i - 1));
        return;
      case "list:edit": {
        const sel = filtered[listIdx];
        if (sel) setEditing(sel);
        return;
      }
      case "search:focus":
        setSearchActive(true);
        return;
      default:
        return;
    }
  });

  const onCommit = async (
    field: FormField,
    value: unknown,
    opts: { force?: boolean } = {},
  ): Promise<void> => {
    try {
      const setOpts: { tenant?: string; force?: boolean } = {};
      if (tenant) setOpts.tenant = tenant;
      if (opts.force) setOpts.force = true;
      const res = await client.setSetting(field.path, value, setOpts);
      try {
        const refreshed = await client.listSettings(tenant ? { tenant } : {});
        setFields(refreshed.items.map(leafToFormField));
      } catch {
        setFields((prev) =>
          prev.map((f) =>
            f.path === field.path
              ? { ...f, value: res.value, source: tenant ? "tenant" : "global" }
              : f,
          ),
        );
      }
      setFlash({
        kind: res.requiresRestart ? "info" : "ok",
        msg: res.requiresRestart
          ? `${field.path} written — restart required for full effect`
          : `${field.path} written`,
      });
      setEditing(null);
      setPendingRestart(null);
    } catch (err) {
      const restart = isRestartRequiredError(err);
      if (restart) {
        setEditing(null);
        setPendingRestart({ field, value, message: restart.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setFlash({ kind: "error", msg: message });
    }
  };

  const onCancel = (): void => setEditing(null);

  const renderEditor = (
    field: FormField,
    commit: (value: unknown) => void,
    cancel: () => void,
  ): React.ReactNode => {
    const Picker = PICKER_REGISTRY[field.path];
    if (Picker) {
      const initial = typeof field.value === "string" ? field.value : "";
      return <Picker initial={initial} onCommit={commit} onCancel={cancel} />;
    }
    return <FieldEditor field={field} onCommit={(_f, v) => commit(v)} onCancel={cancel} />;
  };

  const { start: winStart, end: winEnd } = pickWindow(filtered.length, listIdx, WINDOW_ROWS);
  const visible = filtered.slice(winStart, winEnd);
  const sectionForRow = (row: FormField): string => row.path.split(".")[0] ?? "";
  const showSections = !searchQuery;
  const selected = filtered[listIdx];

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">
          Type to filter · Enter / ↓ select · ↑ tabs · Esc clears filter
          {filtered.length > WINDOW_ROWS
            ? ` · showing ${winStart + 1}–${winEnd} of ${filtered.length}`
            : null}
        </Text>
      </Box>
      <SearchInput
        query={searchQuery}
        active={searchActive}
        matches={filtered.length}
        total={fields.length}
      />
      <Box flexDirection="column" marginTop={1}>
        {filtered.length === 0 ? (
          <Text color="gray">
            {searchQuery
              ? `no settings match "${searchQuery}"`
              : "no editable settings for this scope"}
          </Text>
        ) : (
          visible.map((f, i) => {
            const absoluteIdx = winStart + i;
            const prev = absoluteIdx > 0 ? filtered[absoluteIdx - 1] : null;
            const showDivider =
              showSections && (prev == null || sectionForRow(prev) !== sectionForRow(f));
            return (
              <Box key={f.path} flexDirection="column">
                {showDivider ? (
                  <Box marginTop={absoluteIdx === 0 ? 0 : 1}>
                    <Text color="gray">── {sectionLabel(sectionForRow(f))}</Text>
                  </Box>
                ) : null}
                <SettingItem field={f} selected={absoluteIdx === listIdx} />
              </Box>
            );
          })
        )}
      </Box>
      {selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">─────────────────────────────</Text>
          <Box>
            <Text color="cyan" bold>
              {selected.path}
            </Text>
            <Text color="gray">{`  ·  ${selected.scope}`}</Text>
            {selected.sensitive ? <Text color="yellow">{"  ·  secret"}</Text> : null}
            {selected.requiresRestart ? <Text color="red">{"  ·  restart required"}</Text> : null}
          </Box>
          <Text>{pickDescription(selected)}</Text>
        </Box>
      ) : null}
      {flash ? (
        <Box marginTop={1}>
          <Text color={flash.kind === "error" ? "red" : flash.kind === "info" ? "yellow" : "green"}>
            {flash.kind === "error" ? "✗ " : flash.kind === "info" ? "ℹ " : "✔ "}
            {flash.msg}
          </Text>
        </Box>
      ) : null}
      {editing ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="cyan"
          padding={1}
          flexDirection="column"
        >
          {renderEditor(editing, (v) => void onCommit(editing, v), onCancel)}
        </Box>
      ) : null}
      {pendingRestart ? (
        <ConfirmModal
          title="restart required"
          body={pendingRestart.message}
          onYes={() => void onCommit(pendingRestart.field, pendingRestart.value, { force: true })}
          onNo={() => {
            setPendingRestart(null);
            setFlash({ kind: "info", msg: "cancelled — setting unchanged" });
          }}
        />
      ) : null}
    </Box>
  );
};
