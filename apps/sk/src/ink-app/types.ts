// Shared types for the Ink REPL app.
//
// `InkAppProps` is the public prop contract of `<InkApp>` (re-exported
// from `../ink-app.tsx` so external consumers keep importing it from
// there). The derived aliases below give the extracted ink-app modules
// (status line, welcome row, key handling, …) named handles on the
// prop sub-shapes without re-declaring them — they are indexed access
// types, so they can never drift from the real contract.

import type { SkSessionState, TurnEvent } from "@cli-core/index.ts";

import type {
  EngineClient,
  OperatorHealthDigest,
  RequestCredentialFormEvent,
  SetupValidationResponse,
  StatusSummary,
} from "../engine-client.ts";
import type { MentionCandidate } from "../repl/mention-picker.tsx";
import type { PaneSpec } from "../repl/slash/handler.ts";
import type { PermissionMode, StatusLineConfig } from "../repl/status-line/render.ts";
import type { PersonaProbe } from "../slash.ts";

export interface InkAppProps {
  persona: {
    label: string;
    tenant: string | null;
    engineUrl: string;
    profileName: string;
    probe: PersonaProbe;
  };
  /** Status line configuration from merged settings. */
  statusLineConfig?: StatusLineConfig;
  /** Initial conversation id when resuming. */
  initialConversationId?: string | null;
  /** Current model id for the status-line input payload. */
  model?: string | null;
  /** cwd captured at REPL startup so the status line doesn't race chdir. */
  cwd?: string;
  /**
   * Composite snapshot from `GET /v1/status`. The host refreshes this
   * after every completed turn (or on a slower cadence when idle) and
   * passes the latest into the app. Drives the subkit-tailored status
   * line fields: connectors_count, tokens_today, auth_status, etc.
   */
  statusSnapshot?: StatusSummary | null;
  /** Latest setup diagnostics snapshot when the persona can read it. */
  setupSnapshot?: SetupValidationResponse | null;
  /** Live engine-connection state from the host pinger. `null` means
   *  no pinger is active (tests, smoke paths). */
  connectionSnapshot?: {
    state: "online" | "reconnecting" | "offline" | "unknown";
    reason: string | null;
    last_ok_at: number | null;
    last_error_at: number | null;
  } | null;
  /** Engine operator health digest fetched once at REPL open. Rendered as
   *  the in-context needs-attention panel below the welcome box and used
   *  to inject the "guided triage" starter action. `null` when the tenant
   *  is all-clear or the engine is unreachable. */
  digestSnapshot?: OperatorHealthDigest | null;
  /** Count of proposed session-learning skill candidates awaiting review,
   *  fetched best-effort at REPL open (and on tenant switch). When > 0 and
   *  the persona holds `skill:read`, the welcome row injects a
   *  "Review N proposed learning(s)" starter action. Defaults to 0 so an
   *  absent prop keeps today's behavior. */
  pendingLearningsCount?: number;
  /** Active permission mode for the status line badge. */
  permissionMode?: PermissionMode;
  /**
   * Engine client passed in from the REPL host. Today only the embedded
   * /settings pane needs it; all other engine traffic flows through
   * onPrompt / onSlash / onSelectConversation callbacks. When absent,
   * the embedded /settings pane is unavailable and falls back to
   * suggesting the standalone `sk settings` CLI.
   */
  engineClient?: EngineClient;
  /** Engine-backed @-mention choices loaded by the REPL host. */
  engineMentionCandidates?: readonly MentionCandidate[];
  /**
   * Engine-resolved REPL/UI/notification preferences. Drives `notify()`
   * inside `applyEventStream` — push fires when `pushNotifyEnabled`
   * is true and the turn exceeded the threshold. When omitted, push
   * notifications stay off.
   */
  prefs?: {
    pushNotifyEnabled: boolean;
    pushNotifyThresholdSec: number;
    quietHoursStart: string;
    quietHoursEnd: string;
  };
  /**
   * Per-process override for the push-notify gate, populated from
   * `SK_PUSH_NOTIFY` / `SK_PUSH_NOTIFY_THRESHOLD_MS` exactly once at
   * REPL boot. Reading env on every turn would let a mid-REPL
   * `export SK_PUSH_NOTIFY=1` silently change behavior; reading once
   * at boot keeps the gate aligned with the rest of the boot-time
   * wiring. The fields are optional so a missing env value cleanly
   * defers to `prefs`.
   */
  pushNotifyOverride?: {
    enabled?: boolean;
    thresholdMs?: number;
  };
  /**
   * Override the persistent-history file path. Tests pass a tmpdir
   * path so they don't read / mutate the real `~/.sk/history.jsonl`.
   */
  historyPath?: string;
  /**
   * Toggle for the next-message ghost-text preview. Defaults to true.
   * Read from SkSettings.nextCommandPreviewEnabled at REPL boot. When
   * false, the Composer ignores incoming `next_suggestion` frames.
   */
  nextCommandPreviewEnabled?: boolean;
  /** Called when the user submits a plain prompt (non-slash). The
   *  optional `event` is the typed no-LLM turn event (secret-redirect
   *  confirmation); the host threads it onto the message-append body —
   *  it only exists on the append route, so a create-conversation
   *  first turn drops it and relies on the prose fallback in `text`. */
  onPrompt: (
    text: string,
    opts?: {
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      event?: RequestCredentialFormEvent;
    },
  ) => Promise<{ events: AsyncIterable<TurnEvent>; conversationId: string }>;
  /** Called when the user submits a slash command other than `/exit`. */
  onSlash?: (
    name: string,
    raw: string,
    openPane: (spec: PaneSpec) => void,
    liveSession: SkSessionState,
  ) => Promise<string | null>;
  /**
   * Resume a past conversation — invoked when the user selects one from
   * the `/resume` browser pane. Returns the newly-attached id so the
   * Ink app can reset its session state.
   */
  onSelectConversation?: (id: string) => Promise<void>;
  /** Called on any elicitation response so the app can POST to the engine. */
  onElicitResponse?: (
    elicitationId: string,
    output: unknown,
    reason?: string,
  ) =>
    | Promise<{ events?: AsyncIterable<TurnEvent>; conversationId?: string | null } | undefined>
    | Promise<void>;
  /** Called when the user exits. */
  onExit?: () => void;
  /**
   * Called when the user presses Esc during a long-running turn.
   * Routes to `engineClient.cancelConversation(id)`
   * which fires the engine's abort signal so the in-flight stream
   * ends with `cancelled` instead of `succeeded` / `failed`.
   */
  onCancelConversation?: (conversationId: string) => Promise<unknown>;
  /**
   * Optional resume summary rendered at the top of the transcript on a
   * fresh attach. Populated by the host from `GET /v1/conversations/:id`'s
   * `resume_summary` field when the user re-enters a paused authoring
   * session.
   */
  resumeSummary?: {
    active_target: {
      kind: "connector" | "workflow" | "none";
      name: string | null;
      environment: string | null;
    };
    stage: string;
    next_action: string;
    one_sentence: string;
    last_successful_probe: string | null;
    last_successful_preview: string | null;
  } | null;
}

/** Persona identity block passed down from the REPL host. */
export type PersonaInfo = InkAppProps["persona"];

/** Live engine-connection snapshot (non-null variant). */
export type ConnectionSnapshot = NonNullable<InkAppProps["connectionSnapshot"]>;

/** Resume summary card payload (non-null variant). */
export type ResumeSummary = NonNullable<InkAppProps["resumeSummary"]>;

/** Push-notification preferences resolved by the engine. */
export type NotifyPrefs = NonNullable<InkAppProps["prefs"]>;

/** Boot-time push-notify env override. */
export type PushNotifyOverride = NonNullable<InkAppProps["pushNotifyOverride"]>;

/** Transcript rendering mode — `chat` hides background/tool noise,
 *  `inspect` shows every call with detailed output. */
export type TranscriptMode = "chat" | "inspect";
