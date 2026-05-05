import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { EngineClient } from "../engine-client.ts";
import { FieldEditor } from "./components/FieldEditor.tsx";
import { Footer } from "./components/Footer.tsx";
import { SettingItem } from "./components/SettingItem.tsx";
import type { FormField } from "./lib/zod-to-form-fields.ts";

interface Props {
  sections: Map<string, FormField[]>;
  pendingRestartKeys: string[];
  overrideKeys: string[];
  tenant?: string;
  initialTab?: string;
  client: EngineClient;
  onExit: (code: number) => void;
}

export const SettingsModal: React.FC<Props> = ({
  sections,
  pendingRestartKeys,
  overrideKeys,
  tenant,
  initialTab,
  client,
  onExit,
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

  // Keep `fields` in sync when the tab changes.
  React.useEffect(() => {
    const nextSection = sectionNames[tabIdx] ?? "";
    setFields(sections.get(nextSection) ?? []);
    setListIdx(0);
  }, [tabIdx, sections, sectionNames]);

  useInput((input, key) => {
    if (editing) return; // FieldEditor owns input while editing
    if (key.escape || input === "q") {
      onExit(0);
      return;
    }
    if (key.tab && !key.shift) {
      setTabIdx((i) => (i + 1) % sectionNames.length);
      return;
    }
    if (key.tab && key.shift) {
      setTabIdx((i) => (i - 1 + sectionNames.length) % sectionNames.length);
      return;
    }
    if (key.upArrow) {
      setListIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setListIdx((i) => Math.min(fields.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const sel = fields[listIdx];
      if (sel) setEditing(sel);
      return;
    }
  });

  const onCommit = async (field: FormField, value: unknown): Promise<void> => {
    try {
      const opts: { tenant?: string; force?: boolean } = {};
      if (tenant) opts.tenant = tenant;
      const res = await client.setSetting(field.path, value, opts);
      // Update local view with the masked-or-real echo from the server.
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setFlash({ kind: "error", msg: message });
      // Stay in editor so the operator can fix and retry.
    }
  };

  const onCancel = (): void => {
    setEditing(null);
  };

  const currentSection = sectionNames[tabIdx] ?? "";
  const headerLine = (
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
      <Box marginBottom={1}>
        <Text bold>sk settings configure</Text>
        {tenant ? <Text color="yellow"> (tenant: {tenant})</Text> : null}
      </Box>
      {headerLine}
      <Box flexDirection="column" marginTop={1}>
        {fields.length === 0 ? (
          <Text color="gray">
            Section "{currentSection}" has no editable leaves for this scope.
          </Text>
        ) : (
          fields.map((f, i) => <SettingItem key={f.path} field={f} selected={i === listIdx} />)
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
          <FieldEditor field={editing} onCommit={onCommit} onCancel={onCancel} />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Footer editing={editing !== null} />
      </Box>
    </Box>
  );
};
