// Transcript assembly for the Ink REPL.
//
// `buildTranscript` turns the live session state into the two render
// buckets the app paints from — committed scrollback (Ink `<Static>`)
// and the still-running dynamic tail — plus the flat pager entries for
// the Ctrl-P modal and the bottom-of-screen elicitation fallback.
// Pure function of its inputs: no hooks, no state, no engine traffic.

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
  /** Live session state (logs, diffs, streaming buffer, elicitation). */
  session: SkSessionState;
  /** Deferred copy of `session.messages` — keeps typing responsive. */
  messages: SkSessionState["messages"];
  /** Deferred copy of `session.toolCalls`. */
  toolCalls: ToolCallState[];
  columns: number;
  transcriptMode: TranscriptMode;
  busy: boolean;
  /** Synchronous busy guard — the prose-choice double-fire gate reads
   *  it at keypress time, not render time. */
  busyRef: React.MutableRefObject<boolean>;
  /** True while a pane / launcher / slash buffer owns the keyboard —
   *  disables the inline prompt components' input. */
  elicitInputDisabled: boolean;
  /** Welcome banner + starter chrome, prepended as the first
   *  scrollback row. */
  welcomeRow: React.ReactNode;
  /** Dispatches a synthetic prompt through the submit path. */
  onSubmit: (raw: string) => void;
  /** Routes a structured elicitation answer to the engine. */
  onRespondElicitation: (elicitationId: string, output: unknown, reason?: string) => void;
}

export interface TranscriptBuildResult {
  staticRows: React.ReactNode[];
  dynamicRows: React.ReactNode[];
  pagerEntries: PagerEntry[];
  /** Bottom-of-screen ElicitRouter for elicitations without a
   *  `parent_message_id` anchor; `null` when anchored or absent. */
  elicitFallback: React.ReactNode;
}

// Build transcript rows split across two buckets so Ink can render
// the committed scrollback through <Static> (written once to stdout,
// survives re-renders, keeps OS-level mouse selection working) and
// the currently-running turn through the normal dynamic tree.
//
// Static commit point: a message is "finalized" the moment it lands
// in session.messages — applyTurnEvent only pushes there at the end
// of a message. Tool calls with status "ok"/"failed"/"declined" are
// likewise finalized. Anything still running (streaming assistant
// text, in-flight tool cards, pending elicit) stays dynamic.
//
// Tool calls, logs, and pending elicit forms are interleaved under
// their parent assistant message via `parent_message_id`. Children
// without an anchor (legacy data, or live events that arrived
// pre-anchor) render in a trailing block at the end so nothing gets
// dropped. This is the fix for the chronological-display bug — see
// the plan at .claude/plans/find-issues-in-display-tranquil-harp.md.
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
  // Alias used by render helpers below — they push into whichever
  // array is currently "active". Starts with static; we switch to
  // dynamic once a not-yet-finalized node appears.
  let transcriptRows = staticRows;
  const inspectView = transcriptMode === "inspect";
  // A tool call has reached a terminal status and can live in Static.
  // (Pending/running calls stay dynamic so their spinner keeps updating
  // without tearing the scrollback above.)
  const isToolCallFinalized = (call: ToolCallState): boolean =>
    call.status === "done" || call.status === "failed";

  // Bucket tool calls by parent_message_id. Order within each bucket
  // is preserved from `deferredToolCalls` (which the reducer appends
  // in arrival order = chronological).
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
  /**
   * Render a list of tool calls (already in chronological order)
   * into transcriptRows. Groups consecutive background tools into a
   * compact pill, drops the rest through the authoring-card / ToolCard
   * branches. Mirrors the old single-block logic but is callable
   * per-message-row so children land directly under their parent.
   */
  const renderToolCallList = (calls: ToolCallState[], keyPrefix: string): void => {
    let pendingBackgroundCalls: ToolCallState[] = [];
    let bgIdx = 0;
    // De-duplication of CONSECUTIVE identical card signatures —
    // session 86de186b stacked 4 identical "Execution needs
    // diagnosis · partial_success · v2 · 1 warning" cards in a row
    // when the LLM retried run_workflow without changing the
    // workflow. The signature compares tool name + status + the
    // structured outcome (success/error_code/partial_success
    // marker). When N consecutive calls collapse to the same
    // signature, we render the FIRST card and append a "(×N)"
    // multiplier instead of N stacked clones. Inspect view bypasses
    // the dedupe so an operator can still see every call individually.
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
      // Consecutive-dedupe check. When this card's signature matches
      // the previous one, replace the previous card with a "(×N)"-
      // suffixed version instead of pushing a clone.
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
        // Render `tool_log` entries inline under: (a) anything in
        // inspect view, (b) any failed tool so the diagnosis is
        // visible, (c) any RUNNING tool so the user sees per-step
        // progress as it streams (the run_workflow / dry_run_workflow
        // tools emit one tool_log per step → that lets the user watch
        // the loop iterate live), or (d) when SK_VERBOSE=1 forces
        // every successful tool to render its full log.
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
        // Tool succeeded but still suggested next actions (rare —
        // typically `ok: true` won't have a chip list, but the helper
        // already gates on `ok: false`). Surface the chips even when
        // we suppress the verbose ToolCard in chat mode.
        transcriptRows.push(<NextBestActionsChips key={`chips-${call.id}`} actions={chips} />);
      }
    }
    if (inspectView && pendingBackgroundCalls.length > 0) {
      flushBackgroundGroup(pendingBackgroundCalls, `${keyPrefix}-${bgIdx++}`);
    }
  };

  // Pending elicitation gets inlined under its parent message when
  // anchored. Falls back to a bottom-of-screen render below the
  // ScrollView when no anchor is available (legacy data, or events
  // that arrived before the assistant message was persisted).
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

  // Bucket diff cells by parent_message_id so they thread under the
  // assistant message that triggered them. Diffs without an anchor
  // render in a trailing block at the end (rare — only when the
  // diff TurnEvent arrived before any assistant message in the turn).
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

  // Pager entries — flat list of every cell rendered in chronological
  // order with full payloads (no truncation). Built once per render so
  // toggling the pager doesn't recompute on each keystroke.
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
    // Skip empty assistant turns. Tool-only steps carry an
    // engine-side parent-anchor row whose content is `{}` — that
    // empty object normalises to text="" via parseRenderableMessage
    // Content's isEffectivelyEmpty guard, so the row reaches us with
    // both content and parts blank. The child tool calls below still
    // render under the same parent_message_id; dropping the empty
    // header row only removes the speaker line, never the work the
    // turn produced.
    const trimmedContent = (m.content ?? "").trim();
    const isEmptyAssistantStub =
      m.role === "assistant" && trimmedContent === "" && (!m.parts || m.parts.length === 0);
    if (!isEmptyAssistantStub) {
      // Turn separator: a single dim-grey rule before each user
      // message that follows earlier output. It's the cheapest visual
      // signal "a new turn starts here" without using red — red is
      // reserved in this REPL for `tone === "error"` notices and the
      // `ctx N/M` overflow chip in the footer. Using red between every
      // turn would normalise the alarm color and weaken the real
      // warnings.
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
        />,
      );
      renderedAnyMessageBefore = true;
    }
    if (m.id) {
      const childCalls = callsByParent.get(m.id);
      if (childCalls && childCalls.length > 0) {
        // Split children: finalized → static (alongside this message),
        // still-running → dynamic (appended below so the spinner
        // keeps animating without re-rendering the scrollback).
        const finalized = childCalls.filter(isToolCallFinalized);
        const active = childCalls.filter((c) => !isToolCallFinalized(c));
        if (finalized.length > 0) renderToolCallList(finalized, `m${i}`);
        if (active.length > 0) {
          transcriptRows = dynamicRows;
          renderToolCallList(active, `m${i}-active`);
          transcriptRows = staticRows;
        }
      }
      // Render any threaded diff cells under this assistant message.
      // Structural mutation is visible inline at the moment
      // it lands, no scroll-back required.
      const childDiffs = diffsByParent.get(m.id);
      if (childDiffs && childDiffs.length > 0) {
        for (const d of childDiffs) {
          transcriptRows.push(
            <DiffCard key={`diff-${d.id}`} title={d.title} language={d.language} hunks={d.hunks} />,
          );
        }
      }
      if (elicitAnchor === m.id) {
        // Pending elicit is by definition unresolved → dynamic.
        transcriptRows = dynamicRows;
        renderElicitInline();
        transcriptRows = staticRows;
      }
    }
  }
  // Trailing orphan diffs (no parent_message_id) — render dynamically
  // so they update if more land before the next assistant message.
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
  // Live streaming assistant buffer — rendered in the dynamic bucket
  // until the next `message` frame arrives and clears it. Keeps the
  // REPL responsive as tokens arrive rather than waiting for the turn
  // to end, while the finished scrollback above stays in Static.
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
  // Prose-options translator. The LLM occasionally still emits a
  // numbered list with a trailing question ("1. Run … 2. Show … Which
  // would you prefer?") despite the STRUCTURED USER INTERACTION skill
  // rule. When that shape lands and no real elicitation is pending,
  // synthesise a ChoicePrompt under the message so the user gets an
  // actual ink picker instead of having to type "1" or "yes" into a
  // free-text composer. Pre-fix sessions dcdcf246 / 86de186b kept
  // hitting this anti-pattern.
  if (
    !busy &&
    pendingElicit === null &&
    session.streamingAssistantText.length === 0 &&
    deferredToolCalls.every(isToolCallFinalized)
  ) {
    const lastAssistant = lastAssistantText(session);
    const detected = detectProseOptions(lastAssistant);
    if (detected) {
      // Anchor the synthesised pick to the message id of the
      // assistant turn whose text it came from. When that id
      // changes (engine emits a new assistant message), the
      // ChoicePrompt re-mounts — keys old focused state from
      // bleeding across forks.
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
              // Belt-and-braces double-fire guard. ChoicePrompt's
              // useInput hook can fire twice in rapid succession
              // when the user mashes Enter / a digit, and the
              // synchronous `setBusy(true)` race in handleSubmit
              // would otherwise queue the duplicate via the prompt
              // queue. We never want a queued duplicate from a
              // single pick — read busyRef directly so the
              // second fire bails before any side effect.
              if (busyRef.current) return;
              onSubmit(out.value);
            }}
          />
        </Box>,
      );
    }
  }
  // Orphaned tool calls (no parent_message_id, or anchor not in
  // current messages array). Rendered as a trailing block so nothing
  // is silently dropped — happens for legacy conversations from before
  // engine migration 0032 AND for live SSE streams where a tool_result
  // arrives before its parent message frame.
  //
  // Render-bucket choice is critical: orphan cards MUST go into
  // dynamicRows, not staticRows. Session 1222158a reproduced the
  // "✓ Endpoint check complete" appearing twice — once when the call
  // was orphan (parent message hadn't streamed yet) and again after
  // the message arrived and the call moved into callsByParent. Ink's
  // <Static> never un-flushes a row, so the first orphan render stays
  // on stdout while the new parented render is appended below it,
  // visually duplicating the card. Keeping orphan cards dynamic lets
  // them migrate into static cleanly under the parent on the next
  // re-render.
  if (orphanCalls.length > 0) {
    transcriptRows = dynamicRows;
    renderToolCallList(orphanCalls, "orphan");
    transcriptRows = staticRows;
  }

  // Welcome banner + starter actions + resume card are pushed ONCE into
  // the Static stream as the first scrollback rows. Ink's <Static> flushes
  // them to stdout and never re-invokes them; as the transcript grows they
  // scroll up out of the terminal naturally. Rendering them in the live
  // region (the previous behaviour) made the compact-mode chip float
  // between the scrolled-out transcript and the composer once the
  // committed history exceeded one screenful — the cause of the "banner
  // sitzt falsch" reflow visible in long sessions.
  staticRows.unshift(welcomeRow);

  // Elicit router — bottom-of-screen fallback for elicitations
  // that arrived without a `parent_message_id` (legacy data, or
  // live events that landed before the parent assistant message
  // was persisted). Anchored elicitations render inline inside
  // the transcript above, under their parent message — see
  // `renderElicitInline` in the transcript loop.
  const elicitFallback =
    session.pendingElicitation && elicitAnchor === null
      ? ((pendingElicitation) => (
          <ElicitRouter
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
          />
        ))(session.pendingElicitation)
      : null;

  return { staticRows, dynamicRows, pagerEntries, elicitFallback };
}
