import { hyperlink } from "@chat-ui/index.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

import { categoryIconFor } from "../domain/connectors/category-icons.ts";

function iconForDriver(driver: string | undefined): string {
  return categoryIconFor(driver);
}

export interface OnboardingTemplate {
  slug: string;
  name?: string;
  driver?: string;
  auth_type?: string;
  description?: string;
  oauth?: {
    authorization_url?: string | undefined;
    scopes?: readonly string[] | null | undefined;
  } | null;
  setup_instructions?: string | null;
}

export interface OnboardingProbeResult {
  ok: boolean;
  reason?: string | null;
}

export interface OnboardingSaveResult {
  ok: boolean;
  connector_id?: string | null;
  reason?: string | null;
}

export interface OnboardingWizardProps {
  templates: readonly OnboardingTemplate[];
  onProbe: (template: OnboardingTemplate, credential: string) => Promise<OnboardingProbeResult>;
  onSave: (template: OnboardingTemplate, credential: string) => Promise<OnboardingSaveResult>;
  onDone: (result: { status: "saved" | "cancelled" | "skipped"; reason?: string }) => void;
}

type Step = "pick" | "credential" | "probe" | "save" | "done";

interface WizardState {
  step: Step;
  templateIndex: number;
  credential: string;
  probeError: string | null;
  saveError: string | null;
  savedConnectorId: string | null;
  busy: boolean;
}

function isPasswordOnlyCredential(template: OnboardingTemplate | undefined): boolean {
  if (!template) return false;
  return (template.auth_type ?? "") !== "oauth2";
}

function describeCredential(template: OnboardingTemplate | undefined): string {
  if (!template) return "credential";
  const auth = template.auth_type ?? "credential";
  switch (auth) {
    case "bearer":
      return "API token (Bearer)";
    case "basic":
      return "API key (Basic auth)";
    case "api_key":
      return "API key";
    case "oauth2":
      return "OAuth2 token";
    case "none":
      return "(no credential required)";
    default:
      return auth;
  }
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  templates,
  onProbe,
  onSave,
  onDone,
}) => {
  const [state, setState] = useState<WizardState>({
    step: "pick",
    templateIndex: 0,
    credential: "",
    probeError: null,
    saveError: null,
    savedConnectorId: null,
    busy: false,
  });

  const selected = templates[state.templateIndex];

  const advanceFromPick = (): void => {
    if (!selected) return;
    setState((prev) => ({ ...prev, step: "credential" }));
  };

  const runProbe = async (template: OnboardingTemplate, credential: string): Promise<void> => {
    setState((prev) => ({ ...prev, step: "probe", busy: true, probeError: null }));
    try {
      const result = await onProbe(template, credential);
      if (result.ok) {
        setState((prev) => ({ ...prev, step: "save", busy: false, probeError: null }));
        await runSave(template, credential);
        return;
      }
      setState((prev) => ({
        ...prev,
        busy: false,
        probeError: result.reason ?? "probe failed",
      }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "probe failed";
      setState((prev) => ({ ...prev, busy: false, probeError: reason }));
    }
  };

  const runSave = async (template: OnboardingTemplate, credential: string): Promise<void> => {
    setState((prev) => ({ ...prev, step: "save", busy: true, saveError: null }));
    try {
      const result = await onSave(template, credential);
      if (result.ok) {
        setState((prev) => ({
          ...prev,
          step: "done",
          busy: false,
          saveError: null,
          savedConnectorId: result.connector_id ?? null,
        }));
        return;
      }
      setState((prev) => ({
        ...prev,
        busy: false,
        saveError: result.reason ?? "save failed",
      }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "save failed";
      setState((prev) => ({ ...prev, busy: false, saveError: reason }));
    }
  };

  useInput((input, key) => {
    if (state.busy) return;

    if (key.escape) {
      onDone({ status: "cancelled" });
      return;
    }

    if (state.step === "pick") {
      if (key.upArrow) {
        setState((prev) => ({
          ...prev,
          templateIndex:
            (prev.templateIndex - 1 + templates.length) % Math.max(templates.length, 1),
        }));
        return;
      }
      if (key.downArrow) {
        setState((prev) => ({
          ...prev,
          templateIndex: (prev.templateIndex + 1) % Math.max(templates.length, 1),
        }));
        return;
      }
      if (key.return && templates.length > 0) {
        advanceFromPick();
        return;
      }
      return;
    }

    if (state.step === "credential") {
      if (input === "s" && key.ctrl === false && key.meta === false && state.credential === "") {
        onDone({ status: "skipped" });
        return;
      }
      if (key.return) {
        if (selected && state.credential.length > 0) {
          void runProbe(selected, state.credential);
          return;
        }
        if (selected && (selected.auth_type === "none" || selected.auth_type === "oauth2")) {
          void runProbe(selected, "");
          return;
        }
        return;
      }
      if (key.backspace || key.delete) {
        setState((prev) => ({ ...prev, credential: prev.credential.slice(0, -1) }));
        return;
      }
      if (input && !key.ctrl && !key.meta && input.length > 0) {
        let printable = "";
        for (const ch of input) {
          const code = ch.codePointAt(0) ?? 0;
          if (code >= 0x20 && code !== 0x7f) printable += ch;
        }
        if (printable.length === 0) return;
        setState((prev) => ({ ...prev, credential: prev.credential + printable }));
        return;
      }
      return;
    }

    if (state.step === "probe") {
      if (key.return && state.probeError !== null && selected) {
        void runProbe(selected, state.credential);
        return;
      }
      return;
    }

    if (state.step === "save") {
      if (key.return && state.saveError !== null && selected) {
        void runSave(selected, state.credential);
        return;
      }
      return;
    }

    if (state.step === "done") {
      if (key.return) {
        onDone({ status: "saved" });
        return;
      }
    }
  });

  if (templates.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>onboarding</Text>
        <Text color="red">no connector templates available — cannot continue</Text>
        <Text color="gray">press Esc to dismiss</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>onboarding wizard</Text>
      <Text color="gray">step {stepIndex(state.step)} of 4 · Esc to cancel</Text>
      <Box marginTop={1} />
      {state.step === "pick" ? (
        <PickStep templates={templates} index={state.templateIndex} />
      ) : null}
      {state.step === "credential" && selected ? (
        <CredentialStep template={selected} credential={state.credential} />
      ) : null}
      {state.step === "probe" && selected ? (
        <ProbeStep template={selected} busy={state.busy} probeError={state.probeError} />
      ) : null}
      {state.step === "save" && selected ? (
        <SaveStep template={selected} busy={state.busy} saveError={state.saveError} />
      ) : null}
      {state.step === "done" && selected ? (
        <DoneStep template={selected} connectorId={state.savedConnectorId} />
      ) : null}
    </Box>
  );
};

OnboardingWizard.displayName = "OnboardingWizard";

function stepIndex(step: Step): number {
  switch (step) {
    case "pick":
      return 1;
    case "credential":
      return 2;
    case "probe":
      return 3;
    case "save":
    case "done":
      return 4;
  }
}

const PickStep: React.FC<{
  templates: readonly OnboardingTemplate[];
  index: number;
}> = ({ templates, index }) => {
  return (
    <Box flexDirection="column">
      <Text>Pick a template:</Text>
      {templates.map((template, i) => {
        const focused = i === index;
        const label = template.name ?? template.slug;
        const driver = template.driver ?? "—";
        const auth = template.auth_type ?? "—";
        const icon = iconForDriver(template.driver);
        return focused ? (
          <Text key={template.slug} color="cyan" bold>
            {`› ${icon} ${label} · ${driver} · ${auth}`}
          </Text>
        ) : (
          <Text key={template.slug}>{`  ${icon} ${label} · ${driver} · ${auth}`}</Text>
        );
      })}
      <Text color="gray">↑/↓ select · Enter continue</Text>
    </Box>
  );
};

const CredentialStep: React.FC<{
  template: OnboardingTemplate;
  credential: string;
}> = ({ template, credential }) => {
  const masked = "•".repeat(credential.length);
  const label = describeCredential(template);
  const oauth = template.auth_type === "oauth2";
  return (
    <Box flexDirection="column">
      <Text>
        Template: <Text bold>{template.name ?? template.slug}</Text>
      </Text>
      {template.setup_instructions ? <Text color="gray">{template.setup_instructions}</Text> : null}
      {oauth ? (
        <Box flexDirection="column">
          <Text>
            OAuth2 flow — open the authorization URL in your browser, complete the consent, and
            return here.
          </Text>
          {template.oauth?.authorization_url ? (
            <Text color="cyan">{hyperlink(template.oauth.authorization_url)}</Text>
          ) : null}
          {template.oauth?.scopes && template.oauth.scopes.length > 0 ? (
            <Text color="gray">scopes: {template.oauth.scopes.join(" ")}</Text>
          ) : null}
          <Text color="gray">Enter to confirm completion · Esc to cancel</Text>
        </Box>
      ) : isPasswordOnlyCredential(template) ? (
        <Box flexDirection="column">
          <Text>
            Enter the {label}: <Text bold>{masked || "(empty)"}</Text>
            {credential.length > 0 ? <Text color="gray">{`  (${credential.length})`}</Text> : null}
          </Text>
          <Text color="gray">type to fill · Backspace to edit · Enter to probe · `s` to skip</Text>
        </Box>
      ) : (
        <Text>No credential required — Enter to probe.</Text>
      )}
    </Box>
  );
};

const ProbeStep: React.FC<{
  template: OnboardingTemplate;
  busy: boolean;
  probeError: string | null;
}> = ({ template, busy, probeError }) => {
  return (
    <Box flexDirection="column">
      <Text>
        Probing <Text bold>{template.name ?? template.slug}</Text>…
      </Text>
      {busy ? <Text color="yellow">running probe…</Text> : null}
      {probeError ? (
        <Box flexDirection="column">
          <Text color="red">probe failed: {probeError}</Text>
          <Text color="gray">Enter to retry · Esc to cancel</Text>
        </Box>
      ) : null}
    </Box>
  );
};

const SaveStep: React.FC<{
  template: OnboardingTemplate;
  busy: boolean;
  saveError: string | null;
}> = ({ template, busy, saveError }) => {
  return (
    <Box flexDirection="column">
      <Text>
        Saving connector for <Text bold>{template.name ?? template.slug}</Text>…
      </Text>
      {busy ? <Text color="yellow">saving…</Text> : null}
      {saveError ? (
        <Box flexDirection="column">
          <Text color="red">save failed: {saveError}</Text>
          <Text color="gray">Enter to retry · Esc to cancel</Text>
        </Box>
      ) : null}
    </Box>
  );
};

const DoneStep: React.FC<{
  template: OnboardingTemplate;
  connectorId: string | null;
}> = ({ template, connectorId }) => {
  return (
    <Box flexDirection="column">
      <Text color="green">
        ✓ Connector created — run <Text bold>/connectors list</Text> to see it
      </Text>
      <Text color="gray">
        template: {template.name ?? template.slug}
        {connectorId ? ` · id: ${connectorId.slice(0, 8)}` : ""}
      </Text>
      <Text color="gray">Enter to dismiss</Text>
    </Box>
  );
};
