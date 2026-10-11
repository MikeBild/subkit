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
  statusLineConfig?: StatusLineConfig;
  initialConversationId?: string | null;
  initialContextStatus?: string | null;
  model?: string | null;
  cwd?: string;
  statusSnapshot?: StatusSummary | null;
  setupSnapshot?: SetupValidationResponse | null;
  connectionSnapshot?: {
    state: "online" | "reconnecting" | "offline" | "unknown";
    reason: string | null;
    last_ok_at: number | null;
    last_error_at: number | null;
  } | null;
  digestSnapshot?: OperatorHealthDigest | null;
  pendingLearningsCount?: number;
  permissionMode?: PermissionMode;
  engineClient?: EngineClient;
  engineMentionCandidates?: readonly MentionCandidate[];
  prefs?: {
    pushNotifyEnabled: boolean;
    pushNotifyThresholdSec: number;
    quietHoursStart: string;
    quietHoursEnd: string;
  };
  pushNotifyOverride?: {
    enabled?: boolean;
    thresholdMs?: number;
  };
  historyPath?: string;
  nextCommandPreviewEnabled?: boolean;
  onPrompt: (
    text: string,
    opts?: {
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      event?: RequestCredentialFormEvent;
      raw_prompt?: string;
    },
  ) => Promise<{
    events: AsyncIterable<TurnEvent>;
    conversationId: string;
    contextStatus?: string | null;
  }>;
  onSlash?: (
    name: string,
    raw: string,
    openPane: (spec: PaneSpec) => void,
    liveSession: SkSessionState,
  ) => Promise<string | null>;
  onSelectConversation?: (id: string) => Promise<void>;
  onElicitResponse?: (
    elicitationId: string,
    output: unknown,
    reason?: string,
  ) =>
    | Promise<{ events?: AsyncIterable<TurnEvent>; conversationId?: string | null } | undefined>
    | Promise<void>;
  onExit?: () => void;
  onCancelConversation?: (conversationId: string) => Promise<unknown>;
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

export type PersonaInfo = InkAppProps["persona"];

export type ConnectionSnapshot = NonNullable<InkAppProps["connectionSnapshot"]>;

export type ResumeSummary = NonNullable<InkAppProps["resumeSummary"]>;

export type NotifyPrefs = NonNullable<InkAppProps["prefs"]>;

export type PushNotifyOverride = NonNullable<InkAppProps["pushNotifyOverride"]>;

export type TranscriptMode = "chat" | "inspect";
