import { ChoicePrompt, type ElicitationResponse, ElicitRouter } from "@chat-ui/index.ts";
import type { SkSessionState, ToolCallState } from "@cli-core/index.ts";
import { lastAssistantText } from "@cli-core/index.ts";
import { Box, Text } from "ink";
import type React from "react";
import { renderAuthoringCard } from "../repl/authoring-cards.tsx";
import { BackgroundToolGroup, isBackgroundTool } from "../repl/background-tools.tsx";
import { DiffCard } from "../repl/diff-cell.tsx";
import { detectProseOptions } from "../repl/prose-options-detector.ts";
import type { PagerEntry } from "../shell/TranscriptPager.tsx";
import {
  extractNextBestActions,
  MESSAGE_ROW_INDENT,
  MessageRow,
  NextBestActionsChips,
  ToolCard,
  TurnSeparator,
} from "./transcript-cells.tsx";
import type { TranscriptMode } from "./types.ts";

export interface TranscriptBuildInput {
  session: SkSessionState;
  messages: SkSessionState["messages"];
  toolCalls: ToolCallState[];
  columns: number;
  transcriptMode: TranscriptMode;
  busy: boolean;
  busyRef: React.MutableRefObject<boolean>;
  elicitInputDisabled: boolean;
  welcomeRow: React.ReactNode;
  onSubmit: (raw: string) => void;
  onRespondElicitation: (elicitationId: string, output: unknown, reason?: string) => void;
}

export interface TranscriptBuildResult {
  staticRows: React.ReactNode[];
  dynamicRows: React.ReactNode[];
  pagerEntries: PagerEntry[];
  elicitFallback: React.ReactNode;
}

export function buildTranscript(input: TranscriptBuildInput): TranscriptBuildResult {
  const {
    session,
    messages: deferredMessages,
    toolCalls: deferredToolCalls,
    columns,
    transcriptMode,
    busy,
    busyRef,
    elicitInputDisabled,
    welcomeRow,
    onSubmit,
    onRespondElicitation,
  } = input;
  const staticRows: React.ReactNode[] = [];
  const dynamicRows: React.ReactNode[] = [];
  let transcriptRows = staticRows;
  const inspectView = transcriptMode === "inspect";
  const isToolCallFinalized = (call: ToolCallState): boolean =>
    call.status === "done" || call.status === "failed";

  const callsByParent = new Map<string, ToolCallState[]>();
  const orphanCalls: ToolCallState[] = [];
  const knownMessageIds = new Set<string>();
  for (const m of deferredMessages) if (m?.id) knownMessageIds.add(m.id);
  for (const call of deferredToolCalls) {
    const anchor = call.parent_message_id;
    if (anchor && knownMessageIds.has(anchor)) {
      const list = callsByParent.get(anchor) ?? [];
      list.push(call);
      callsByParent.set(anchor, list);
    } else {
      orphanCalls.push(call);
    }
  }

  const pushForegroundLogs = (callId: string): void => {
    const logs = session.toolLogs.filter((log) => log.call_id === callId);
    if (logs.length === 0) return;
    transcriptRows.push(
      <Box key={`tl-${callId}`} flexDirection="column" marginLeft={2}>
        {logs.map((log, idx) => (
          <Text key={`${callId}-${idx}`} color="gray">
            · [{log.level}] {log.message}
          </Text>
        ))}
      </Box>,
    );
  };
  const flushBackgroundGroup = (calls: ToolCallState[], keySuffix: string): void => {
    if (calls.length === 0) return;
    const ids = new Set(calls.map((call) => call.id));
    const logs = session.toolLogs.filter((log) => ids.has(log.call_id));
    transcriptRows.push(
      <BackgroundToolGroup
        key={`bg-${keySuffix}-${calls.map((call) => call.id).join("-")}`}
        calls={calls}
        logs={logs}
        detailed={inspectView}
      />,
    );
  };
  const renderToolCallList = (calls: ToolCallState[], keyPrefix: string): void => {
    let pendingBackgroundCalls: ToolCallState[] = [];
    let bgIdx = 0;
    let lastCardSignature: string | null = null;
    let lastCardCount = 0;
    let lastCardIndex = -1;
    const cardSignatureFor = (c: ToolCallState): string | null => {
      if (inspectView) return null;
      const result = (c.result ?? {}) as Record<string, unknown>;
      const data = (result.data ?? {}) as Record<string, unknown>;
      const status = typeof data.status === "string" ? data.status : c.status;
      const errorCode = typeof data.error_code === "string" ? data.error_code : null;
      const requiresRepair = data.requires_repair === true ? "rr" : "";
      const warningsCount = Array.isArray(data.warnings) ? (data.warnings as unknown[]).length : 0;
      return [c.name, status, errorCode ?? "", requiresRepair, warningsCount].join("|");
    };
    for (const call of calls) {
      if (isBackgroundTool(call)) {
        if (!inspectView) continue;
        pendingBackgroundCalls.push(call);
        continue;
      }
      if (pendingBackgroundCalls.length > 0) {
        flushBackgroundGroup(pendingBackgroundCalls, `${keyPrefix}-${bgIdx++}`);
        pendingBackgroundCalls = [];
      }
      const chips = extractNextBestActions(call.result);
      const authoringCard = inspectView ? null : renderAuthoringCard(call, transcriptMode);
      const signature = authoringCard ? cardSignatureFor(call) : null;
      if (
        authoringCard &&
        signature !== null &&
        signature === lastCardSignature &&
        lastCardIndex === transcriptRows.length - 1
      ) {
        lastCardCount += 1;
        transcriptRows[lastCardIndex] = (
          <Box key={`dup-${call.id}`} flexDirection="column" marginBottom={1}>
            {authoringCard}
            <Box marginLeft={2}>
              <Text dimColor>{`(repeated ${lastCardCount}× — same outcome)`}</Text>
            </Box>
          </Box>
        );
        continue;
      }
      lastCardSignature = signature;
      lastCardCount = 1;
      if (authoringCard) {
        transcriptRows.push(authoringCard);
        lastCardIndex = transcriptRows.length - 1;
        const showLogs =
          inspectView ||
          call.status === "failed" ||
          call.status === "running" ||
          call.status === "pending" ||
          process.env.SK_VERBOSE === "1";
        if (showLogs) pushForegroundLogs(call.id);
        if (chips.length > 0) {
          transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
        }
        continue;
      }
      if (inspectView || call.status === "failed") {
        transcriptRows.push(
          <ToolCard key={`tc-${call.id}`} call={call} columns={columns} detailed={inspectView} />,
        );
        pushForegroundLogs(call.id);
        if (chips.length > 0) {
          transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
        }
      } else if (chips.length > 0) {
        transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
      }
    }
    if (inspectView && pendingBackgroundCalls.length > 0) {
      flushBackgroundGroup(pendingBackgroundCalls, `${keyPrefix}-${bgIdx++}`);
    }
  };

  const pendingElicit = session.pendingElicitation;
  const elicitAnchor =
    pendingElicit?.parent_message_id && knownMessageIds.has(pendingElicit.parent_message_id)
      ? pendingElicit.parent_message_id
      : null;
  const renderElicitInline = (): void => {
    if (!pendingElicit) return;
    transcriptRows.push(
      <ElicitRouter
        key={`elicit-${pendingElicit.id}`}
        elicitation={pendingElicit}
        inputDisabled={elicitInputDisabled}
        onResponse={(out) => {
          const resp = out as ElicitationResponse;
          const reason =
            "decision_reason" in resp && typeof resp.decision_reason === "string"
              ? resp.decision_reason
              : undefined;
          onRespondElicitation(pendingElicit.id, resp, reason);
        }}
      />,
    );
  };

  const diffsByParent = new Map<string, typeof session.diffs>();
  const orphanDiffs: typeof session.diffs = [];
  for (const d of session.diffs) {
    if (d.parentMessageId) {
      const list = diffsByParent.get(d.parentMessageId) ?? [];
      list.push(d);
      diffsByParent.set(d.parentMessageId, list);
    } else {
      orphanDiffs.push(d);
    }
  }

  const pagerEntries: PagerEntry[] = [];
  for (let i = 0; i < deferredMessages.length; i++) {
    const m = deferredMessages[i];
    if (!m) continue;
    pagerEntries.push({
      id: m.id ?? `pager-msg-${i}`,
      kind: m.role === "user" ? "user" : "assistant",
      text: m.content,
    });
    if (m.id) {
      const childCalls = callsByParent.get(m.id);
      if (childCalls) {
        for (const c of childCalls) {
          pagerEntries.push({ id: `pager-tc-${c.id}`, kind: "tool", toolCall: c });
        }
      }
      const childDiffs = diffsByParent.get(m.id);
      if (childDiffs) {
        for (const d of childDiffs) {
          pagerEntries.push({
            id: `pager-diff-${d.id}`,
            kind: "diff",
            diff: { title: d.title, language: d.language, hunks: d.hunks },
          });
        }
      }
    }
  }
  for (const c of orphanCalls) {
    pagerEntries.push({ id: `pager-tc-orphan-${c.id}`, kind: "tool", toolCall: c });
  }
  for (const d of orphanDiffs) {
    pagerEntries.push({
      id: `pager-diff-orphan-${d.id}`,
      kind: "diff",
      diff: { title: d.title, language: d.language, hunks: d.hunks },
    });
  }
  let renderedAnyMessageBefore = false;
  for (let i = 0; i < deferredMessages.length; i++) {
    const m = deferredMessages[i];
    if (!m) continue;
    const trimmedContent = (m.content ?? "").trim();
    const isEmptyAssistantStub =
      m.role === "assistant" && trimmedContent === "" && (!m.parts || m.parts.length === 0);
    if (!isEmptyAssistantStub) {
      if (m.role === "user" && renderedAnyMessageBefore) {
        transcriptRows.push(<TurnSeparator key={`sep-${i}`} columns={columns} />);
      }
      transcriptRows.push(
        <MessageRow
          key={`msg-${i}`}
          role={m.role}
          content={m.content}
          parts={m.parts}
          columns={columns}
          citations={m.citations}
        />,
      );
      renderedAnyMessageBefore = true;
    }
    if (m.id) {
      const childCalls = callsByParent.get(m.id);
      if (childCalls && childCalls.length > 0) {
        const finalized = childCalls.filter(isToolCallFinalized);
        const active = childCalls.filter((c) => !isToolCallFinalized(c));
        if (finalized.length > 0) renderToolCallList(finalized, `m${i}`);
        if (active.length > 0) {
          transcriptRows = dynamicRows;
          renderToolCallList(active, `m${i}-active`);
          transcriptRows = staticRows;
        }
      }
      const childDiffs = diffsByParent.get(m.id);
      if (childDiffs && childDiffs.length > 0) {
        for (const d of childDiffs) {
          transcriptRows.push(
            <DiffCard key={`diff-${d.id}`} title={d.title} language={d.language} hunks={d.hunks} />,
          );
        }
      }
      if (elicitAnchor === m.id) {
        transcriptRows = dynamicRows;
        renderElicitInline();
        transcriptRows = staticRows;
      }
    }
  }
  if (orphanDiffs.length > 0) {
    transcriptRows = dynamicRows;
    for (const d of orphanDiffs) {
      transcriptRows.push(
        <DiffCard
          key={`diff-orphan-${d.id}`}
          title={d.title}
          language={d.language}
          hunks={d.hunks}
        />,
      );
    }
    transcriptRows = staticRows;
  }
  if (session.streamingAssistantText.length > 0) {
    dynamicRows.push(
      <MessageRow
        key="live-delta"
        role={"assistant" as const}
        content={session.streamingAssistantText}
        columns={columns}
      />,
    );
  }
  if (
    !busy &&
    pendingElicit === null &&
    session.streamingAssistantText.length === 0 &&
    deferredToolCalls.every(isToolCallFinalized)
  ) {
    const lastAssistant = lastAssistantText(session);
    const detected = detectProseOptions(lastAssistant);
    if (detected) {
      const lastAssistantMsg = (() => {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const m = session.messages[i];
          if (m?.role === "assistant") return m;
        }
        return null;
      })();
      const anchorKey = lastAssistantMsg?.id ?? lastAssistant.length.toString(36);
      dynamicRows.push(
        <Box key={`prose-choice-${anchorKey}`} marginLeft={MESSAGE_ROW_INDENT}>
          <ChoicePrompt
            question={detected.question}
            options={detected.options.map((o) => ({ value: o.value, label: o.label }))}
            inputDisabled={elicitInputDisabled}
            onResponse={(out) => {
              if (busyRef.current) return;
              onSubmit(out.value);
            }}
          />
        </Box>,
      );
    }
  }
  if (orphanCalls.length > 0) {
    transcriptRows = dynamicRows;
    renderToolCallList(orphanCalls, "orphan");
    transcriptRows = staticRows;
  }

  staticRows.unshift(welcomeRow);

  if (session.pendingElicitation && elicitAnchor === null) {
    const pendingElicitation = session.pendingElicitation;
    dynamicRows.push(
      <ElicitRouter
        key={`elicit-${pendingElicitation.id}`}
        elicitation={pendingElicitation}
        inputDisabled={elicitInputDisabled}
        onResponse={(out) => {
          const resp = out as ElicitationResponse;
          const reason =
            "decision_reason" in resp && typeof resp.decision_reason === "string"
              ? resp.decision_reason
              : undefined;
          onRespondElicitation(pendingElicitation.id, resp, reason);
        }}
      />,
    );
  }

  return { staticRows, dynamicRows, pagerEntries, elicitFallback: null };
}
