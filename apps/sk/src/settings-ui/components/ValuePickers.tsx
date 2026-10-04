import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

interface OptionRow {
  value: string;
  label: string;
  preview?: string;
}

interface PickerProps {
  title: string;
  options: readonly OptionRow[];
  initial: string;
  layout?: "single" | "side-by-side";
  termWidth?: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

const SIDE_BY_SIDE_THRESHOLD = 120;

const PickerImpl: React.FC<PickerProps> = ({
  title,
  options,
  initial,
  layout,
  termWidth = process.stdout.columns ?? 80,
  onCommit,
  onCancel,
}) => {
  const [idx, setIdx] = useState(() => {
    const f = options.findIndex((o) => o.value === initial);
    return f >= 0 ? f : 0;
  });

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const sel = options[idx];
      if (sel) onCommit(sel.value);
      return;
    }
    if (key.upArrow) {
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIdx((i) => Math.min(options.length - 1, i + 1));
      return;
    }
  });

  const sel = options[idx];
  const useSideBySide =
    layout === "side-by-side" || (layout !== "single" && termWidth >= SIDE_BY_SIDE_THRESHOLD);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      <Text color="gray">↑/↓ navigate · Enter to apply · Esc to cancel</Text>
      <Box marginTop={1}>
        <Box flexDirection="column" width={useSideBySide ? 30 : undefined}>
          {options.map((o, i) => (
            <Box key={o.value}>
              <Text color={i === idx ? "cyan" : "white"}>{i === idx ? "› " : "  "}</Text>
              <Text>{o.label}</Text>
              <Text color="gray"> ({o.value})</Text>
            </Box>
          ))}
        </Box>
        {useSideBySide && sel?.preview ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color="gray">preview</Text>
            <Box marginTop={1}>
              <Text>{sel.preview}</Text>
            </Box>
          </Box>
        ) : null}
      </Box>
      {!useSideBySide && sel?.preview ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">preview</Text>
          <Text>{sel.preview}</Text>
        </Box>
      ) : null}
    </Box>
  );
};

export const ThemePicker: React.FC<{
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  termWidth?: number;
}> = ({ initial, onCommit, onCancel, termWidth }) => {
  const props: PickerProps = {
    title: "Theme",
    options: [
      { value: "auto", label: "Auto", preview: "Match terminal background" },
      { value: "light", label: "Light", preview: "■■ light surface · ▒▒ dim · ■■ accent" },
      { value: "dark", label: "Dark", preview: "■■ dark surface · ▒▒ dim · ■■ accent" },
      { value: "high-contrast", label: "High contrast", preview: "Maximum legibility" },
    ],
    initial,
    onCommit,
    onCancel,
  };
  if (termWidth !== undefined) props.termWidth = termWidth;
  return <PickerImpl {...props} />;
};

export const PersonalityPicker: React.FC<{
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}> = ({ initial, onCommit, onCancel }) => (
  <PickerImpl
    title="Personality"
    options={[
      { value: "concise", label: "Concise" },
      { value: "balanced", label: "Balanced" },
      { value: "verbose", label: "Verbose" },
    ]}
    initial={initial}
    layout="single"
    onCommit={onCommit}
    onCancel={onCancel}
  />
);

export const TitleConfigurator: React.FC<{
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}> = ({ initial, onCommit, onCancel }) => (
  <PickerImpl
    title="Title format"
    options={[
      { value: "session-id", label: "Session id (8 chars)", preview: "sk · a1b2c3d4" },
      { value: "tenant-session", label: "Tenant + session", preview: "sk · acme · a1b2c3d4" },
      {
        value: "model-tenant-session",
        label: "Model + tenant + session",
        preview: "sk · opus-4-7 · acme · a1b2c3d4",
      },
    ]}
    initial={initial}
    layout="single"
    onCommit={onCommit}
    onCancel={onCancel}
  />
);

export const StatuslineConfigurator: React.FC<{
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}> = ({ initial, onCommit, onCancel }) => (
  <PickerImpl
    title="Status line"
    options={[
      { value: "minimal", label: "Minimal", preview: "ask · online" },
      { value: "compact", label: "Compact", preview: "ask · online · 1.2k tokens" },
      {
        value: "detailed",
        label: "Detailed",
        preview: "ask · online · acme · opus-4-7 · 1.2k tokens",
      },
    ]}
    initial={initial}
    layout="single"
    onCommit={onCommit}
    onCancel={onCancel}
  />
);
