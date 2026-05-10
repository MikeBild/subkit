// Config tab — flat searchable list of every setting leaf, across all
// engine sections. Filter narrows on path or description; Enter opens
// the existing FieldEditor; two-step Esc clears the filter, then the
// outer Esc closes the modal.
//
// Reuses SearchInput, SettingItem, FieldEditor from settings-ui/components.

import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { type EngineClient, SkEngineError } from "../../engine-client.ts";
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
import type { FormField } from "../lib/zod-to-form-fields.ts";

// G5 closure of #159 M11 / S2 of PR #161 review (round 6) — single
// registry mapping a setting path to the Ink picker component that
// renders it. Adding a row here is the *only* hook needed to surface
// a value picker; the picker writes via the same setSetting path the
// FieldEditor uses. Earlier code carried the path list in
// `PICKER_PATHS` plus a parallel switch statement; drift between the
// two was a future-bug waiting to happen.
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
  onSearchActiveChange?: (active: boolean) => void;
}

interface PendingRestart {
  field: FormField;
  value: unknown;
  message: string;
}

function isRestartRequiredError(err: unknown): { message: string } | null {
  if (err instanceof SkEngineError && err.code === "restart_required") {
    return { message: err.message };
  }
  return null;
}

export const ConfigTab: React.FC<Props> = ({
  fields: initialFields,
  tenant,
  client,
  onSearchActiveChange,
}) => {
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [listIdx, setListIdx] = useState(0);
  const [editing, setEditing] = useState<FormField | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  const [flash, setFlash] = useState<{ kind: "info" | "error" | "ok"; msg: string } | null>(null);

  useEffect(() => {
    onSearchActiveChange?.(searchActive || searchQuery.length > 0);
  }, [searchActive, searchQuery, onSearchActiveChange]);

  const filtered = useMemo(() => {
    if (!searchQuery) return fields;
    const q = searchQuery.toLowerCase();
    return fields.filter(
      (f) => f.path.toLowerCase().includes(q) || (f.description ?? "").toLowerCase().includes(q),
    );
  }, [fields, searchQuery]);

  // Keep listIdx in bounds when the filter shrinks the visible list.
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
      setFields((prev) =>
        prev.map((f) =>
          f.path === field.path
            ? { ...f, value: res.value, source: tenant ? "tenant" : "global" }
            : f,
        ),
      );
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

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="gray">Type to filter · Enter / ↓ select · ↑ tabs · Esc clears filter</Text>
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
              ? `no leaves match "${searchQuery}"`
              : "no editable settings for this scope"}
          </Text>
        ) : (
          filtered.map((f, i) => <SettingItem key={f.path} field={f} selected={i === listIdx} />)
        )}
      </Box>
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
            setFlash({ kind: "info", msg: "cancelled — leaf unchanged" });
          }}
        />
      ) : null}
    </Box>
  );
};
