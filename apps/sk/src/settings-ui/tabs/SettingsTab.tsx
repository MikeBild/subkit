// Settings tab — the original SettingsModal content extracted intact.
// Renders engine-schema-derived setting sections with inner tab nav,
// search, edit, and pending-restart confirmation.
//
// The outer 10-tab shell (SettingsModal) wraps this. `tabActive` flags
// whether this tab is the currently visible outer tab; when false the
// component returns null so its useInput handler is unmounted and the
// outer shell owns key dispatch.

import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import { type EngineClient, SkEngineError } from "../../engine-client.ts";
import { ConfirmModal } from "../components/ConfirmModal.tsx";
import { FieldEditor } from "../components/FieldEditor.tsx";
import { Footer } from "../components/Footer.tsx";
import { SearchInput } from "../components/SearchInput.tsx";
import { SettingItem } from "../components/SettingItem.tsx";
import { resolveAction } from "../keybindings/useKeybinding.ts";
import type { FormField } from "../lib/zod-to-form-fields.ts";

interface Props {
  sections: Map<string, FormField[]>;
  pendingRestartKeys: string[];
  overrideKeys: string[];
  tenant?: string;
  initialTab?: string;
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

export const SettingsTab: React.FC<Props> = ({
  sections,
  pendingRestartKeys,
  overrideKeys,
  tenant,
  initialTab,
  client,
  onSearchActiveChange,
}) => {
  const sectionNames = [...sections.keys()];
  const [tabIdx, setTabIdx] = useState(() => {
    if (initialTab) {
      const idx = sectionNames.indexOf(initialTab);
      if (idx >= 0) return idx;
    }
    return 0;
  });
  const [listIdx, setListIdx] = useState(0);
  const [editing, setEditing] = useState<FormField | null>(null);
  const [flash, setFlash] = useState<{ kind: "info" | "error" | "ok"; msg: string } | null>(null);
  const [fields, setFields] = useState<FormField[]>(sections.get(sectionNames[tabIdx] ?? "") ?? []);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);

  React.useEffect(() => {
    onSearchActiveChange?.(searchActive || searchQuery.length > 0);
  }, [searchActive, searchQuery, onSearchActiveChange]);

  React.useEffect(() => {
    const nextSection = sectionNames[tabIdx] ?? "";
    setFields(sections.get(nextSection) ?? []);
    setListIdx(0);
    setSearchQuery("");
  }, [tabIdx, sections, sectionNames]);

  const filtered = searchQuery
    ? fields.filter(
        (f) =>
          f.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (f.description ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : fields;

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
      case "settings:close":
        // Outer shell owns Esc; the SettingsTab no longer eagerly closes
        // on Esc when not searching. The outer SettingsModal catches the
        // same key first via its own useInput. Leaving this branch as a
        // no-op preserves the existing keybinding map without intercepting.
        return;
      case "settings:tab-next":
        setTabIdx((i) => (i + 1) % sectionNames.length);
        return;
      case "settings:tab-prev":
        setTabIdx((i) => (i - 1 + sectionNames.length) % sectionNames.length);
        return;
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

  const innerTabStrip = (
    <Box>
      {sectionNames.map((s, i) => (
        <Text key={s} color={i === tabIdx ? "cyan" : "gray"} bold={i === tabIdx}>
          {`${s}${i === sectionNames.length - 1 ? "" : "  "}`}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {innerTabStrip}
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
              ? `no leaves match "${searchQuery}" in this section`
              : `section has no editable leaves for this scope`}
          </Text>
        ) : (
          filtered.map((f, i) => <SettingItem key={f.path} field={f} selected={i === listIdx} />)
        )}
      </Box>
      {pendingRestartKeys.length > 0 ? (
        <Box marginTop={1}>
          <Text color="yellow">pending restart: </Text>
          <Text>{pendingRestartKeys.join(", ")}</Text>
        </Box>
      ) : null}
      {overrideKeys.length > 0 ? (
        <Box>
          <Text color="gray">active overrides: </Text>
          <Text>{overrideKeys.join(", ")}</Text>
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
          <FieldEditor field={editing} onCommit={(f, v) => onCommit(f, v)} onCancel={onCancel} />
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
      <Box marginTop={1}>
        <Footer
          editing={editing !== null}
          searching={searchActive}
          confirming={pendingRestart !== null}
        />
      </Box>
    </Box>
  );
};
