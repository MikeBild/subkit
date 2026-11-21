import { ConversationBrowser, FormPrompt, Pane, StatusPane } from "@chat-ui/index.ts";
import type { SkSessionState } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { memo } from "react";
import type { EngineClient, SetupValidationResponse } from "../engine-client.ts";
import { OnboardingWizard } from "../repl/onboarding-wizard.tsx";
import type { PaneSpec } from "../repl/slash/handler.ts";
import { AdminCommand } from "../settings-ui/AdminCommand.tsx";
import { ProfileCommand } from "../settings-ui/ProfileCommand.tsx";
import { SettingsPane } from "../settings-ui/SettingsPane.tsx";

const PaneLabelRow: React.FC<{ label: string; value: string; dim?: boolean }> = memo(
  ({ label, value, dim = false }) => (
    <Box>
      <Text dimColor>{label}: </Text>
      {dim ? <Text color="gray">{value}</Text> : <Text>{value}</Text>}
    </Box>
  ),
);
PaneLabelRow.displayName = "PaneLabelRow";

const TemplatePickerPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "template-picker" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    {pane.connector_name ? <PaneLabelRow label="connector" value={pane.connector_name} /> : null}
    {pane.current_template ? (
      <PaneLabelRow label="current template" value={pane.current_template} />
    ) : null}
    <Box flexDirection="column" marginTop={1}>
      {pane.lines.map((line, i) => (
        <Text key={`tpl-${i}`}>{line}</Text>
      ))}
    </Box>
  </Pane>
));
TemplatePickerPane.displayName = "TemplatePickerPane";

const ConfigFormPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "config-form" }>;
  onDismiss: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
  inputDisabled?: boolean | undefined;
}> = memo(({ pane, onDismiss, onSaved, onError, inputDisabled }) => (
  <FormPrompt
    question="Configure sk defaults"
    fields={pane.fields.map((field) => ({ ...field }))}
    inputDisabled={inputDisabled}
    onCancel={onDismiss}
    onResponse={(out) => {
      void pane
        .onSave(out.values)
        .then((message) => {
          onSaved(message);
          onDismiss();
        })
        .catch((err) => {
          onError(err instanceof Error ? err.message : String(err));
        });
    }}
  />
));
ConfigFormPane.displayName = "ConfigFormPane";

const ConnectorDraftPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "connector-draft" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="name" value={pane.connector.name} />
    <PaneLabelRow label="slug" value={pane.connector.slug} />
    <PaneLabelRow label="driver" value={pane.connector.driver} />
    <PaneLabelRow label="environment" value={pane.connector.environment} />
    <PaneLabelRow label="auth" value={pane.connector.auth_type} />
    <PaneLabelRow label="base_url" value={pane.connector.base_url} />
    <PaneLabelRow label="dsn" value={pane.connector.dsn} />
    <PaneLabelRow label="template" value={pane.connector.template} />
    <PaneLabelRow label="saved id" value={pane.connector.saved_id} />
    {pane.missing_fields.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow" bold>
          validation
        </Text>
        <Text color="yellow">missing: {pane.missing_fields.join(", ")}</Text>
      </Box>
    ) : null}
    {pane.latest_probe ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pane.latest_probe.ok ? "green" : "red"} bold>
          latest probe
        </Text>
        <PaneLabelRow
          label="request"
          value={`${pane.latest_probe.method} ${pane.latest_probe.path}`}
        />
        <PaneLabelRow label="environment" value={pane.latest_probe.environment} />
        <PaneLabelRow label="http" value={pane.latest_probe.status} />
        <PaneLabelRow label="duration" value={pane.latest_probe.duration} />
        <PaneLabelRow label="summary" value={pane.latest_probe.summary} />
        <PaneLabelRow label="failure code" value={pane.latest_probe.failure_code} />
      </Box>
    ) : null}
  </Pane>
));
ConnectorDraftPane.displayName = "ConnectorDraftPane";

const WorkflowDraftPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "workflow-draft" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="name" value={pane.workflow.name} />
    <PaneLabelRow label="slug" value={pane.workflow.slug} />
    <PaneLabelRow label="description" value={pane.workflow.description} />
    <Box flexDirection="column" marginTop={1}>
      <Text color={pane.workflow.steps.length > 0 ? "green" : "yellow"} bold>
        steps · {pane.workflow.steps.length}
      </Text>
      {pane.workflow.steps.map((step) => (
        <Text key={`wf-step-${step.id}`}>
          {step.id} · {step.kind}
        </Text>
      ))}
    </Box>
    {pane.latest_preview ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pane.latest_preview.ok ? "green" : "red"} bold>
          latest preview
        </Text>
        <PaneLabelRow label="step" value={pane.latest_preview.step} />
        <PaneLabelRow label="summary" value={pane.latest_preview.summary} />
      </Box>
    ) : null}
  </Pane>
));
WorkflowDraftPane.displayName = "WorkflowDraftPane";

const StepDetailPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "step-detail" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="ordinal" value={String(pane.step.ordinal)} />
    <PaneLabelRow label="id" value={pane.step.id} />
    <PaneLabelRow label="kind" value={pane.step.kind} />
    <Box flexDirection="column" marginTop={1}>
      {pane.step.lines.map((line, i) => (
        <Text key={`step-line-${i}`}>{line}</Text>
      ))}
    </Box>
  </Pane>
));
StepDetailPane.displayName = "StepDetailPane";

const ContextPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "context" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="draft mode" value={pane.snapshot.draft_mode} />
    <PaneLabelRow label="authoring mode" value={pane.snapshot.authoring_mode ?? "—"} />
    <PaneLabelRow label="stage" value={pane.snapshot.authoring_stage ?? "—"} />
    <PaneLabelRow label="readiness" value={pane.snapshot.draft_summary?.readiness ?? "—"} />
    <PaneLabelRow
      label="next action"
      value={pane.snapshot.next_required_action ?? pane.snapshot.draft_summary?.next_action ?? "—"}
    />
    <PaneLabelRow
      label="blocked by"
      value={pane.snapshot.draft_summary?.blocked_by.join(", ") || "—"}
    />
    <PaneLabelRow label="messages" value={String(pane.snapshot.messages.total)} />
    <PaneLabelRow label="last role" value={pane.snapshot.messages.last_role ?? "—"} />
    <PaneLabelRow label="calls" value={String(pane.snapshot.tool_calls_total)} />
    <PaneLabelRow label="pending elicitations" value={String(pane.snapshot.pending_elicitations)} />
    {pane.snapshot.active_target ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          active target
        </Text>
        <Text>
          {pane.snapshot.active_target.kind}
          {pane.snapshot.active_target.name ? ` · ${pane.snapshot.active_target.name}` : ""}
          {pane.snapshot.active_target.slug ? ` · ${pane.snapshot.active_target.slug}` : ""}
          {pane.snapshot.active_target.environment
            ? ` · ${pane.snapshot.active_target.environment}`
            : ""}
          {pane.snapshot.active_target.lifecycle_state
            ? ` · ${pane.snapshot.active_target.lifecycle_state}`
            : ""}
        </Text>
      </Box>
    ) : null}
    {pane.snapshot.checkpoint_statuses.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          checkpoints
        </Text>
        {pane.snapshot.checkpoint_statuses.map((checkpoint) => (
          <Text key={`ctx-checkpoint-${checkpoint.key}`}>
            {checkpoint.key} · {checkpoint.status}
            {checkpoint.verified_by_tool ? ` · ${checkpoint.verified_by_tool}` : ""}
          </Text>
        ))}
      </Box>
    ) : null}
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        skills
      </Text>
      <Text>
        global: {pane.snapshot.skills.global.map((skill) => skill.title).join(", ") || "—"}
      </Text>
      <Text>
        connector: {pane.snapshot.skills.connector.map((skill) => skill.title).join(", ") || "—"}
      </Text>
      <Text>
        workflow: {pane.snapshot.skills.workflow.map((skill) => skill.title).join(", ") || "—"}
      </Text>
    </Box>
    {pane.snapshot.attachments.total > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          attachments
        </Text>
        {pane.snapshot.attachments.items.map((item) => (
          <Text key={`ctx-attachment-${item.slug}`}>
            @attachment:{item.slug}
            {item.filename ? ` (${item.filename})` : ""}
          </Text>
        ))}
      </Box>
    ) : null}
    {pane.snapshot.latest_execution ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          latest execution
        </Text>
        <Text>
          {pane.snapshot.latest_execution.status}
          {pane.snapshot.latest_execution.workflow_version_id
            ? ` · ${pane.snapshot.latest_execution.workflow_version_id}`
            : ""}
          {pane.snapshot.latest_execution.warnings_count > 0
            ? ` · ${pane.snapshot.latest_execution.warnings_count} warnings`
            : ""}
          {pane.snapshot.latest_execution.diagnosis_available ? " · diagnosis available" : ""}
        </Text>
      </Box>
    ) : null}
    {pane.snapshot.latest_diagnosis ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          latest diagnosis
        </Text>
        <Text>{pane.snapshot.latest_diagnosis.reason}</Text>
      </Box>
    ) : null}
    {pane.snapshot.last_context_budget ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          context budget (last turn)
        </Text>
        <Text>
          {pane.snapshot.last_context_budget.total_tokens}/
          {pane.snapshot.last_context_budget.cap_tokens} tokens
        </Text>
        <Text>
          {pane.snapshot.last_context_budget.dropped_sections.length > 0
            ? `trimmed to fit: ${pane.snapshot.last_context_budget.dropped_sections.join(", ")}`
            : "nothing was trimmed"}
        </Text>
      </Box>
    ) : null}
    {pane.snapshot.grounding_status?.state === "stale" &&
    pane.snapshot.grounding_status.advisory ? (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow" bold>
          grounding
        </Text>
        <Text color="yellow">⚠ {pane.snapshot.grounding_status.advisory}</Text>
      </Box>
    ) : null}
  </Pane>
));
ContextPane.displayName = "ContextPane";

const ProbeResultsPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "probe-results" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <Text color={pane.probe.ok ? "green" : "red"} bold>
      {pane.probe.ok ? "probe ok" : "probe failed"}
    </Text>
    <PaneLabelRow label="request" value={`${pane.probe.method} ${pane.probe.path}`} />
    <PaneLabelRow label="environment" value={pane.probe.environment} />
    <PaneLabelRow label="http" value={pane.probe.http} />
    <PaneLabelRow label="duration" value={pane.probe.duration} />
    <PaneLabelRow label="summary" value={pane.probe.summary} />
    <PaneLabelRow label="failure code" value={pane.probe.failure_code} />
  </Pane>
));
ProbeResultsPane.displayName = "ProbeResultsPane";

const PreviewResultsPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "preview-results" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <Text color={pane.preview.ok ? "green" : "red"} bold>
      {pane.preview.ok ? "preview ok" : "preview failed"}
    </Text>
    <PaneLabelRow label="step" value={pane.preview.step} />
    <PaneLabelRow label="summary" value={pane.preview.summary} />
    <Box flexDirection="column" marginTop={1}>
      {pane.preview.lines.map((line, i) => (
        <Text key={`preview-line-${i}`}>{line}</Text>
      ))}
    </Box>
  </Pane>
));
PreviewResultsPane.displayName = "PreviewResultsPane";

const VersionBrowserPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "version-browser" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    <PaneLabelRow label="workflow" value={pane.workflow_id} />
    <Box flexDirection="column" marginTop={1}>
      {pane.items.map((item) => (
        <Text key={`version-${item.version}`}>
          v{item.version} · {item.created_at}
          {item.note ? ` · ${item.note}` : ""}
        </Text>
      ))}
    </Box>
    <Box marginTop={1}>
      <Text dimColor>Use /restore &lt;version&gt; to restore a version.</Text>
    </Box>
  </Pane>
));
VersionBrowserPane.displayName = "VersionBrowserPane";

const ApprovalHistoryPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "approval-history" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} onDismiss={onDismiss}>
    {pane.items.map((item, i) => (
      <Box key={`approval-${i}`} flexDirection="column" marginBottom={1}>
        <Text
          color={
            item.status === "approved" ? "green" : item.status === "rejected" ? "red" : "yellow"
          }
          bold
        >
          {item.status} · {item.tool}
        </Text>
        <Text>{item.summary}</Text>
        <Text dimColor>{item.created_at}</Text>
      </Box>
    ))}
  </Pane>
));
ApprovalHistoryPane.displayName = "ApprovalHistoryPane";

const setupSectionOrder: Array<keyof SetupValidationResponse["sections"]> = [
  "auth",
  "llm",
  "datastore",
  "storage",
  "crypto",
  "public_urls",
];

function setupStatusColor(status: "ok" | "warn" | "blocked"): string {
  return status === "ok" ? "green" : status === "blocked" ? "red" : "yellow";
}

const SetupDiagnosticsPane: React.FC<{
  pane: Extract<PaneSpec, { kind: "setup-diagnostics" }>;
  onDismiss: () => void;
}> = memo(({ pane, onDismiss }) => (
  <Pane title={pane.title} subtitle={pane.setup.overall_status} onDismiss={onDismiss}>
    <PaneLabelRow label="blockers" value={String(pane.setup.summary_counts.blockers)} />
    <PaneLabelRow label="warnings" value={String(pane.setup.summary_counts.warnings)} />
    <Box flexDirection="column" marginTop={1}>
      {setupSectionOrder.map((sectionKey) => {
        const section = pane.setup.sections[sectionKey];
        return (
          <Box key={`setup-${sectionKey}`} flexDirection="column" marginBottom={1}>
            <Text color={setupStatusColor(section.status)} bold>
              {section.title} · {section.status}
            </Text>
            {section.issues.map((issue) => (
              <Text
                key={`setup-${sectionKey}-${issue.id}`}
                color={issue.severity === "blocker" ? "red" : "yellow"}
              >
                {issue.severity} · {issue.title} — {issue.detail}
              </Text>
            ))}
            {section.values.map((value) => (
              <PaneLabelRow
                key={`setup-${sectionKey}-value-${value.key}`}
                label={value.key}
                value={
                  value.value === null
                    ? value.status_hint
                      ? `— (${value.status_hint})`
                      : "—"
                    : value.status_hint
                      ? `${value.value} (${value.status_hint})`
                      : value.value
                }
                dim={value.value === null}
              />
            ))}
            {section.recommendations.map((recommendation, index) => (
              <Text key={`setup-${sectionKey}-fix-${index}`} color="cyan">
                fix · {recommendation}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  </Pane>
));
SetupDiagnosticsPane.displayName = "SetupDiagnosticsPane";

interface PaneHostProps {
  pane: PaneSpec | null;
  engineClient?: EngineClient | undefined;
  conversationId: string | null;
  messages: SkSessionState["messages"];
  turnTokens: number | null;
  statusTenantId: string | undefined;
  launcherOpen: boolean;
  onDismiss: () => void;
  showInfo: (message: string) => void;
  showError: (message: string) => void;
  onSelectConversation?: ((id: string) => Promise<void>) | undefined;
  onNewSession: () => void;
  onSignOut: () => void;
  launcherSlot?: React.ReactNode;
}

export const PaneHost: React.FC<PaneHostProps> = ({
  pane,
  engineClient,
  conversationId,
  messages,
  turnTokens,
  statusTenantId,
  launcherOpen,
  onDismiss,
  showInfo,
  showError,
  onSelectConversation,
  onNewSession,
  onSignOut,
  launcherSlot,
}) => (
  <>
    {pane?.kind === "status" ? (
      <StatusPane
        title={pane.title ?? "status"}
        {...(pane.subtitle !== undefined ? { subtitle: pane.subtitle } : {})}
        rows={pane.rows}
        onDismiss={onDismiss}
      />
    ) : null}
    {pane?.kind === "conversations" ? (
      <ConversationBrowser
        items={pane.items}
        onSelect={(id) => {
          onDismiss();
          void onSelectConversation?.(id);
        }}
        onDismiss={onDismiss}
        currentTurns={messages
          .filter((m): m is typeof m & { id: string } => m.role === "assistant" && Boolean(m.id))
          .map((m) => ({
            message_id: m.id,
            excerpt: typeof m.content === "string" ? m.content : "(non-text turn)",
            created_at: null,
          }))}
        onForkFromTurn={(message_id) => {
          if (!engineClient || !conversationId) return;
          void engineClient
            .forkConversationFromMessage(conversationId, message_id)
            .then((res) => {
              onDismiss();
              void onSelectConversation?.(res.conversation.id);
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              showError(`fork failed: ${msg}`);
              onDismiss();
            });
        }}
      />
    ) : null}
    {pane?.kind === "template-picker" ? (
      <TemplatePickerPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "connector-draft" ? (
      <ConnectorDraftPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "workflow-draft" ? (
      <WorkflowDraftPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "step-detail" ? <StepDetailPane pane={pane} onDismiss={onDismiss} /> : null}
    {pane?.kind === "context" ? <ContextPane pane={pane} onDismiss={onDismiss} /> : null}
    {pane?.kind === "probe-results" ? <ProbeResultsPane pane={pane} onDismiss={onDismiss} /> : null}
    {pane?.kind === "preview-results" ? (
      <PreviewResultsPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "version-browser" ? (
      <VersionBrowserPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "approval-history" ? (
      <ApprovalHistoryPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "setup-diagnostics" ? (
      <SetupDiagnosticsPane pane={pane} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "settings" && engineClient ? (
      <SettingsPane
        client={engineClient}
        {...(pane.tenant
          ? { tenant: pane.tenant }
          : statusTenantId
            ? { tenant: statusTenantId }
            : {})}
        {...(pane.initialTab !== undefined ? { initialTab: pane.initialTab } : {})}
        sessionId={pane.sessionId ?? conversationId ?? null}
        sessionTitle={pane.sessionTitle ?? null}
        sessionTokens={pane.sessionTokens ?? turnTokens}
        weekTokens={pane.weekTokens ?? null}
        onDismiss={onDismiss}
      />
    ) : null}
    {pane?.kind === "profile" && engineClient ? (
      <ProfileCommand
        client={engineClient}
        tenant={pane.tenant ?? null}
        onDismiss={onDismiss}
        onAction={(action) => {
          if (action.kind === "new-session") {
            onNewSession();
            return;
          }
          if (action.kind === "sign-out") {
            onDismiss();
            onSignOut();
            return;
          }
        }}
      />
    ) : null}
    {pane?.kind === "admin" && engineClient ? (
      <AdminCommand client={engineClient} tenant={pane.tenant ?? null} onDismiss={onDismiss} />
    ) : null}
    {pane?.kind === "config-form" ? (
      <ConfigFormPane
        pane={pane}
        onDismiss={onDismiss}
        onSaved={showInfo}
        onError={showError}
        inputDisabled={launcherOpen}
      />
    ) : null}
    {pane?.kind === "onboarding-wizard" ? (
      <OnboardingWizard
        templates={pane.templates}
        onProbe={pane.onProbe}
        onSave={pane.onSave}
        onDone={(result) => {
          const { onComplete } = pane;
          onComplete(result);
          onDismiss();
          if (result.status === "saved") {
            showInfo("✓ Connector created — run /connectors list to see it");
          } else if (result.status === "skipped") {
            showInfo("onboarding skipped");
          } else {
            showInfo("onboarding cancelled");
          }
        }}
      />
    ) : null}
    {launcherSlot}
    {pane?.kind === "text" ? (
      <Pane
        title={pane.title}
        {...(pane.subtitle !== undefined ? { subtitle: pane.subtitle } : {})}
        onDismiss={onDismiss}
      >
        {pane.lines.map((line, i) => (
          <Text key={`tp-${i}`}>{line}</Text>
        ))}
      </Pane>
    ) : null}
    {pane?.kind === "portal-token" ? (
      <Pane
        title="portal token (shown once)"
        subtitle={`expires ${pane.expires_at} · ${pane.ttl_minutes} min`}
        onDismiss={onDismiss}
      >
        <Text color="yellow" bold>
          ⚠ this URL is bearer-equivalent — anyone holding it can attach until expiry
        </Text>
        <Text color="gray">workflow: {pane.workflow_id}</Text>
        <Text color="gray">token id: {pane.token_id}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>{pane.url}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray">press Esc to dismiss · 'y' to copy URL to clipboard</Text>
        </Box>
      </Pane>
    ) : null}
    {pane?.kind === "structured" ? (
      <Pane
        title={pane.title}
        {...(pane.subtitle !== undefined ? { subtitle: pane.subtitle } : {})}
        onDismiss={onDismiss}
      >
        {pane.sections.map((section, sIdx) => {
          const headingColor =
            section.tone === "ok"
              ? "green"
              : section.tone === "fail"
                ? "red"
                : section.tone === "warn"
                  ? "yellow"
                  : "cyan";
          return (
            <Box key={`sec-${sIdx}`} flexDirection="column" marginBottom={1}>
              <Text color={headingColor} bold>
                {section.heading}
              </Text>
              {section.rows.map(([k, v], rIdx) => (
                <Box key={`sec-${sIdx}-row-${rIdx}`}>
                  <Text dimColor> {k}: </Text>
                  <Text>{v === null || v === undefined || v === "" ? "—" : String(v)}</Text>
                </Box>
              ))}
            </Box>
          );
        })}
      </Pane>
    ) : null}
  </>
);
