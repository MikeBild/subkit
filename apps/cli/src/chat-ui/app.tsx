// Top-level Ink component for `subkit chat`. The component supports two
// drive modes:
//
//   1. Static — pass a fully-formed `ChatState` via the `state` prop.
//      The component renders it as-is. Existing snapshot-style tests use
//      this path.
//   2. Stream — pass an `AsyncIterable<TurnEvent>` via the `stream` prop
//      (and an optional `initial` ChatState). The component subscribes
//      to the iterable on mount and folds frames into local state via
//      `applyTurnEvent`. When an approval frame arrives the `onApproval`
//      callback is invoked once the user picks Y/N.
//
// The two modes are mutually exclusive — if both are passed, `stream`
// wins. This keeps the canned-state tests untouched while letting the
// REPL command and ink-testing tests share one component.

import { Box, Text } from "ink";
import type React from "react";
import { useEffect, useReducer } from "react";
import { ApprovalPrompt } from "./approval-prompt.tsx";
import { DraftView } from "./draft-view.tsx";
import { applyTurnEvent, type ChatState, initialState, type TurnEvent } from "./hooks.ts";
import { ToolPanel } from "./tool-panel.tsx";

export interface AppProps {
  state?: ChatState | undefined;
  stream?: AsyncIterable<TurnEvent> | undefined;
  initial?: ChatState | undefined;
  onApproval?:
    | ((args: { approvalId: string; decision: "approved" | "rejected" }) => void)
    | undefined;
  /** Suppress useInput in the approval prompt; tests that don't need
   *  to drive keys can keep this true. */
  approvalInputDisabled?: boolean | undefined;
}

type Action = { type: "frame"; event: TurnEvent } | { type: "clearApproval" };

function reducer(state: ChatState, action: Action): ChatState {
  if (action.type === "clearApproval") {
    return { ...state, pendingApproval: null, status: "running" };
  }
  return applyTurnEvent(state, action.event);
}

export function App(props: AppProps): React.ReactElement {
  if (props.stream) {
    return <StreamingApp {...props} stream={props.stream} />;
  }
  const state = props.state ?? initialState(null, null);
  return <ChatView state={state} approvalInputDisabled={true} />;
}

function StreamingApp(props: AppProps & { stream: AsyncIterable<TurnEvent> }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, props.initial ?? initialState(null, null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        for await (const ev of props.stream) {
          if (cancelled) break;
          dispatch({ type: "frame", event: ev });
        }
      } catch {
        // The REPL command surfaces stream errors via its own catch
        // path; here we just stop folding frames.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.stream]);

  const handleDecide = (decision: "approved" | "rejected") => {
    const approval = state.pendingApproval;
    if (!approval) return;
    props.onApproval?.({ approvalId: approval.id, decision });
    dispatch({ type: "clearApproval" });
  };

  return (
    <ChatView
      state={state}
      onApprovalDecide={handleDecide}
      approvalInputDisabled={props.approvalInputDisabled}
    />
  );
}

interface ChatViewProps {
  state: ChatState;
  onApprovalDecide?: ((decision: "approved" | "rejected") => void) | undefined;
  approvalInputDisabled?: boolean | undefined;
}

function ChatView({
  state,
  onApprovalDecide,
  approvalInputDisabled,
}: ChatViewProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1}>
        <Text>
          subkit chat — tenant: <Text bold>{state.context.tenant ?? "(none)"}</Text> · skills:{" "}
          <Text bold>{state.context.skills.join(",") || "(none)"}</Text> · connector:{" "}
          <Text bold>{state.context.connector ?? "(none)"}</Text> · budget:{" "}
          <Text bold>{state.context.token_budget}</Text>
        </Text>
      </Box>
      <Box flexDirection="row">
        <Box flexDirection="column" width={60} paddingRight={1}>
          {state.messages.map((m, idx) => (
            <Box key={`msg-${idx}`} flexDirection="column" marginBottom={1}>
              <Text color={m.role === "user" ? "green" : "cyan"}>{m.role}</Text>
              <Text>{m.content}</Text>
            </Box>
          ))}
          {state.toolCalls.map((call) => (
            <Box key={call.id}>
              <ToolPanel call={call} />
            </Box>
          ))}
          {state.validationErrors.length > 0 ? (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text color="red">validation errors:</Text>
              {state.validationErrors.map((e, idx) => (
                <Text key={`verr-${idx}`} color="red">
                  · {e.path}: {e.message}
                </Text>
              ))}
            </Box>
          ) : null}
          {state.pendingApproval ? (
            onApprovalDecide ? (
              <ApprovalPrompt
                approvalId={state.pendingApproval.id}
                title={state.pendingApproval.title}
                diff={state.pendingApproval.diff}
                onDecide={onApprovalDecide}
                inputDisabled={approvalInputDisabled}
              />
            ) : (
              <Box borderStyle="double" paddingX={1} flexDirection="column">
                <Text color="yellow">approval needed: {state.pendingApproval.title}</Text>
                <Text>{state.pendingApproval.diff}</Text>
                <Text color="gray">press Y to approve, N to reject</Text>
              </Box>
            )
          ) : null}
        </Box>
        <Box flexDirection="column" width={40}>
          <DraftView draft={state.draft} />
        </Box>
      </Box>
      <Box>
        <Text color="gray">
          :undo :reset :skills · Ctrl-C to exit · conversation={state.conversationId ?? "(new)"}
          {state.committedWorkflowId ? ` · committed workflow ${state.committedWorkflowId}` : ""}
          {state.statusDetail ? ` · ${state.statusDetail}` : ""}
        </Text>
      </Box>
    </Box>
  );
}
