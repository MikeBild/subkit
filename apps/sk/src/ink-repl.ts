import {
  applyTurnEvent,
  errorFrameToEvents,
  initialSessionState,
  lastAssistantText,
  readSse,
  type SkSessionState,
  type TurnEvent,
} from "@cli-core/index.ts";
import { VERSION } from "@cli-core/version.ts";
import { AgentBriefingContext } from "./agent-context.ts";
import { loadConfig, type ResolvedProfile, resolveProfile, saveConfig } from "./config.ts";
import { ConnectionPinger, type ConnectionSnapshot } from "./connection-pinger.ts";
import {
  type DebugCorrelationFields,
  debugLog,
  newDebugTurnId,
  serializeDebugError,
} from "./debug.ts";
import {
  EngineClient,
  type OperatorHealthDigest,
  type RequestCredentialFormEvent,
  type SetupValidationResponse,
  type StatusSummary,
} from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { enableBracketedPaste } from "./repl/bracketed-paste.ts";
import { humanizeRequestError } from "./repl/error-humanize.ts";
import { loadMentionCandidates, type MentionCandidate } from "./repl/mention-candidates.ts";
import { fallbackPersona, type ResolvedPersona, resolvePersona } from "./repl/resolved-persona.ts";
import { handleSlash, type PaneSpec } from "./repl/slash/handler.ts";
import { runRepl } from "./repl.ts";
import { saveSessionMetadata } from "./sessions.ts";
import { loadSettings } from "./settings.ts";

export interface InkReplOptions {
  profile: ResolvedProfile;
  initialPrompt?: string;
  resumeConversationId?: string;
  noMemory?: boolean;
}

import { digestAsContext, fetchOperatorDigest } from "./lib/operator-digest.ts";
import { fetchPendingLearningsCount } from "./lib/pending-learnings.ts";

interface OperatorBootSnapshot {
  digest: OperatorHealthDigest | null;
  pendingLearnings: number;
  mentions: MentionCandidate[];
}
export async function runInkRepl(opts: InkReplOptions): Promise<number> {
  if (!process.stdout.isTTY) {
    return runRepl({
      profile: opts.profile,
      ...(opts.initialPrompt ? { initialPrompt: opts.initialPrompt } : {}),
      ...(opts.resumeConversationId ? { resumeConversationId: opts.resumeConversationId } : {}),
      noMemory: Boolean(opts.noMemory),
    });
  }

  const settings = loadSettings(process.cwd());
  const includeMemory = !opts.noMemory && settings.merged.includeMemoryFile !== false;
  const memory = loadMemory({
    cwd: process.cwd(),
    include: includeMemory,
    ...(settings.merged.maxInlineMentionBytes !== undefined
      ? { max_bytes: settings.merged.maxInlineMentionBytes }
      : {}),
  });

  let pendingDigestContext: string | null = null;
  let bootSnapshot: OperatorBootSnapshot = { digest: null, pendingLearnings: 0, mentions: [] };

  const client = new EngineClient({
    engine_url: opts.profile.engine_url,
    api_key: opts.profile.api_key,
    tenant: opts.profile.active_tenant_id,
    user_agent: `sk-cli/${VERSION} (ink)`,
    debug_mode: "ink",
  });

  const canReadSetup = (persona: ResolvedPersona): boolean =>
    persona.allowed.has("audit:read") || persona.allowed.has("identity:read");

  const statusPromise = client.statusSummary().catch(() => null);
  const learningsPromise = fetchPendingLearningsCount(client);
  let currentPersona = await resolvePersona(client, opts.profile);
  const mentionCandidatesPromise = loadMentionCandidates(client, currentPersona.allowed);
  const setupPromise: Promise<SetupValidationResponse | null> = canReadSetup(currentPersona)
    ? client.setupValidation().catch(() => null)
    : Promise.resolve(null);

  const React = (await import("react")) as typeof import("react");
  const ink = await import("ink");
  const appModule = await import("./ink-app.tsx");
  const { InkApp } = appModule;

  let currentConversationId: string | null = opts.resumeConversationId ?? null;
  let currentClient = client;
  let currentProfile = opts.profile;
  let briefingContext = new AgentBriefingContext({
    profile: currentProfile,
    cwd: process.cwd(),
    ...(currentConversationId ? { sessionId: currentConversationId } : {}),
  });
  let briefingReady = briefingContext.start();
  let initialContextStatus = (await briefingReady).status;
  let profileVersion = 0;
  const personaListeners = new Set<
    (snap: { persona: ResolvedPersona; profile: ResolvedProfile; version: number }) => void
  >();

  let statusSnapshot: StatusSummary | null = await statusPromise;
  const statusListeners = new Set<(snap: StatusSummary | null) => void>();
  let setupSnapshot: SetupValidationResponse | null = await setupPromise;
  const setupListeners = new Set<(snap: SetupValidationResponse | null) => void>();
  bootSnapshot = {
    ...bootSnapshot,
    pendingLearnings: await learningsPromise,
    mentions: await mentionCandidatesPromise,
  };
  const bootSnapshotListeners = new Set<(snap: OperatorBootSnapshot) => void>();
  const refreshStatus = async (): Promise<void> => {
    try {
      statusSnapshot = await currentClient.statusSummary();
    } catch {}
    for (const listener of statusListeners) listener(statusSnapshot);
  };

  let connectionSnapshot: ConnectionSnapshot = {
    state: "unknown",
    reason: null,
    last_ok_at: null,
    last_error_at: null,
  };
  const connectionListeners = new Set<(snap: ConnectionSnapshot) => void>();
  const pinger = new ConnectionPinger({ client: currentClient });
  pinger.onChange((snap) => {
    connectionSnapshot = snap;
    for (const listener of connectionListeners) listener(snap);
  });
  pinger.start();

  const onPrompt = async (
    text: string,
    promptOpts?: {
      permission_mode?: "auto" | "ask" | "plan" | "yolo";
      event?: RequestCredentialFormEvent;
      raw_prompt?: string;
    },
  ): Promise<{
    events: AsyncIterable<TurnEvent>;
    conversationId: string;
    contextStatus?: string | null;
  }> => {
    const turn_id = newDebugTurnId("ink");
    const baseCtx = (): DebugCorrelationFields => ({
      mode: "ink",
      conversation_id: currentConversationId,
      turn_id,
    });
    debugLog(
      "dialog.turn_start",
      {
        input_kind: "prompt",
        raw_input: text,
        permission_mode: promptOpts?.permission_mode ?? null,
        memory_sources: memory.sources,
      },
      baseCtx(),
    );
    try {
      await briefingReady;
      const briefingUpdate = await briefingContext.beforePrompt(promptOpts?.raw_prompt ?? text);
      if (briefingUpdate.status) initialContextStatus = briefingUpdate.status;
      const resolved = await resolveMentions(text, {
        cwd: process.cwd(),
        additionalDirectories: settings.merged.additionalDirectories ?? [],
        ...(settings.merged.maxInlineMentionBytes !== undefined
          ? { maxBytes: settings.merged.maxInlineMentionBytes }
          : {}),
        client: currentClient,
      });
      debugLog(
        "dialog.prompt_resolved",
        {
          raw_input: text,
          resolved_prompt: resolved.prompt,
          artifacts: resolved.artifacts,
          references: resolved.references,
          warnings: resolved.warnings,
        },
        baseCtx(),
      );
      for (const warning of resolved.warnings) {
        debugLog("dialog.warning", { warning }, baseCtx());
      }
      const operation: "create_conversation" | "append_message" = currentConversationId
        ? "append_message"
        : "create_conversation";
      const isCreate = operation === "create_conversation";
      const turnMemory = briefingContext.memory(
        memory.content,
        isCreate ? pendingDigestContext : null,
      );
      pendingDigestContext = null;
      const stream = isCreate
        ? await currentClient.createConversationStream(
            {
              initial_message: resolved.prompt,
              ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
              ...(turnMemory ? { memory: turnMemory } : {}),
              ...(settings.merged.model ? { model: settings.merged.model } : {}),
              ...(promptOpts?.permission_mode
                ? { permission_mode: promptOpts.permission_mode }
                : {}),
            },
            baseCtx(),
          )
        : await currentClient.appendConversationMessageStream(
            currentConversationId as string,
            {
              message: resolved.prompt,
              ...(resolved.references.length > 0 ? { references: resolved.references } : {}),
              ...(turnMemory ? { memory: turnMemory } : {}),
              ...(promptOpts?.permission_mode
                ? { permission_mode: promptOpts.permission_mode }
                : {}),
              ...(promptOpts?.event ? { event: promptOpts.event } : {}),
            },
            baseCtx(),
          );

      type QueuedFrame =
        | { kind: "event"; ev: TurnEvent }
        | { kind: "outcome" }
        | { kind: "error"; payload: { code: string; message: string; details?: unknown } };
      const queue: QueuedFrame[] = [];
      let waiter: (() => void) | null = null;
      let closed = false;
      const wakeWaiter = () => {
        const w = waiter;
        waiter = null;
        if (w) w();
      };
      let resolveReadyInner: (() => void) | null = null;
      const ready = new Promise<void>((res) => {
        resolveReadyInner = res;
      });
      const fireReady = (): void => {
        const r = resolveReadyInner;
        resolveReadyInner = null;
        if (r) r();
      };
      if (!isCreate) fireReady();
      const outcomeCtx = (): DebugCorrelationFields => ({
        mode: "ink",
        conversation_id: currentConversationId,
        turn_id,
      });

      const pump = readSse(stream, (frame) => {
        try {
          if (frame.event === "conversation_started") {
            const parsed = JSON.parse(frame.data) as {
              conversation: { id: string; title: string | null; model: string | null };
            };
            currentConversationId = parsed.conversation.id;
            try {
              const now = new Date().toISOString();
              saveSessionMetadata({
                conversation_id: currentConversationId,
                engine_url: opts.profile.engine_url,
                tenant_id: opts.profile.active_tenant_id,
                title: parsed.conversation.title ?? null,
                model: parsed.conversation.model ?? null,
                created_at: now,
                last_used_at: now,
              });
            } catch {}
            fireReady();
            return;
          }
          if (frame.event === "outcome") {
            queue.push({ kind: "outcome" });
            wakeWaiter();
            return;
          }
          if (frame.event === "error") {
            const payload = JSON.parse(frame.data) as {
              code: string;
              message: string;
              details?: unknown;
            };
            queue.push({ kind: "error", payload });
            fireReady();
            wakeWaiter();
            return;
          }
          const ev = JSON.parse(frame.data) as TurnEvent;
          queue.push({ kind: "event", ev });
          wakeWaiter();
        } catch (parseErr) {
          debugLog(
            "dialog.error",
            {
              input_kind: "prompt",
              stage: "sse_frame_parse",
              raw_frame: frame.data,
              error: serializeDebugError(parseErr),
            },
            outcomeCtx(),
          );
        }
      }).then(
        () => {
          closed = true;
          fireReady();
          wakeWaiter();
        },
        (err) => {
          closed = true;
          queue.push({
            kind: "error",
            payload: {
              code: "transport",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          fireReady();
          wakeWaiter();
        },
      );

      await ready;

      async function* iterTurnEvents(): AsyncGenerator<TurnEvent, void, void> {
        let state = initialSessionState(currentConversationId);
        let surfacedError = false;
        const yieldToEventLoop = () =>
          new Promise<void>((resolve) => {
            const schedule =
              typeof setImmediate === "function"
                ? setImmediate
                : (cb: () => void) => setTimeout(cb, 0);
            schedule(() => resolve());
          });
        try {
          while (true) {
            while (queue.length === 0 && !closed) {
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
            }
            const next = queue.shift();
            if (!next) {
              if (closed) break;
              continue;
            }
            if (next.kind === "outcome") {
              break;
            }
            if (next.kind === "error") {
              surfacedError = true;
              for (const synthetic of errorFrameToEvents(next.payload)) {
                state = applyTurnEvent(state, synthetic);
                yield synthetic;
              }
              break;
            }
            const ev = next.ev;
            debugLog("dialog.turn_event", { event: ev }, outcomeCtx());
            state = applyTurnEvent(state, ev);
            yield ev;
            if (ev.type === "completed") {
              void refreshStatus();
            }
            await yieldToEventLoop();
          }
        } finally {
          await pump.catch(() => undefined);
          debugLog(
            "dialog.render_output",
            {
              assistant_text: lastAssistantText(state),
              messages: state.messages,
              tool_calls: state.toolCalls,
              pending_elicitation: state.pendingElicitation,
              validation_errors: state.validationErrors,
              usage: state.usage,
            },
            outcomeCtx(),
          );
          debugLog(
            "dialog.turn_end",
            {
              input_kind: "prompt",
              status: state.status,
              message_count: state.messages.length,
              tool_call_count: state.toolCalls.length,
              validation_error_count: state.validationErrors.length,
              assistant_text: lastAssistantText(state),
              pending_elicitation: state.pendingElicitation,
              usage: state.usage,
              ...(surfacedError ? { transport_error: true } : {}),
            },
            outcomeCtx(),
          );
        }
      }
      return {
        events: iterTurnEvents(),
        conversationId: currentConversationId ?? "",
        contextStatus: briefingUpdate.status,
      };
    } catch (err) {
      debugLog(
        "dialog.error",
        {
          input_kind: "prompt",
          stage: "onPrompt",
          raw_input: text,
          error: serializeDebugError(err),
        },
        baseCtx(),
      );
      throw err;
    }
  };

  const onElicitResponse = async (
    elicitationId: string,
    output: unknown,
    reason?: string,
  ): Promise<{ events?: AsyncIterable<TurnEvent>; conversationId?: string | null }> => {
    if (!currentConversationId) return {};
    const turn_id = newDebugTurnId("ink-elicit");
    const ctx = (): DebugCorrelationFields => ({
      mode: "ink",
      conversation_id: currentConversationId,
      turn_id,
    });
    debugLog(
      "dialog.turn_start",
      {
        input_kind: "elicitation",
        elicitation_id: elicitationId,
        output,
        reason: reason ?? null,
      },
      ctx(),
    );
    debugLog(
      "elicitation.response",
      {
        elicitation_id: elicitationId,
        output,
        reason: reason ?? null,
      },
      ctx(),
    );
    try {
      const stream = await currentClient.respondElicitationStream(
        currentConversationId,
        elicitationId,
        output,
        reason,
        ctx(),
      );

      type QueuedFrame =
        | { kind: "event"; ev: TurnEvent }
        | { kind: "outcome" }
        | { kind: "error"; payload: { code: string; message: string; details?: unknown } };
      const queue: QueuedFrame[] = [];
      let waiter: (() => void) | null = null;
      let closed = false;
      const wakeWaiter = () => {
        const w = waiter;
        waiter = null;
        if (w) w();
      };

      const pump = readSse(stream, (frame) => {
        try {
          if (frame.event === "outcome") {
            queue.push({ kind: "outcome" });
            wakeWaiter();
            return;
          }
          if (frame.event === "error") {
            const payload = JSON.parse(frame.data) as {
              code: string;
              message: string;
              details?: unknown;
            };
            queue.push({ kind: "error", payload });
            wakeWaiter();
            return;
          }
          const ev = JSON.parse(frame.data) as TurnEvent;
          queue.push({ kind: "event", ev });
          wakeWaiter();
        } catch (parseErr) {
          debugLog(
            "dialog.error",
            {
              input_kind: "elicitation",
              stage: "sse_frame_parse",
              raw_frame: frame.data,
              error: serializeDebugError(parseErr),
            },
            ctx(),
          );
        }
      }).then(
        () => {
          closed = true;
          wakeWaiter();
        },
        (err) => {
          closed = true;
          queue.push({
            kind: "error",
            payload: {
              code: "transport",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          wakeWaiter();
        },
      );

      async function* iterTurnEvents(): AsyncGenerator<TurnEvent, void, void> {
        let state = initialSessionState(currentConversationId);
        const yieldToEventLoop = () =>
          new Promise<void>((resolve) => {
            const schedule =
              typeof setImmediate === "function"
                ? setImmediate
                : (cb: () => void) => setTimeout(cb, 0);
            schedule(() => resolve());
          });
        try {
          while (true) {
            while (queue.length === 0 && !closed) {
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
            }
            const next = queue.shift();
            if (!next) {
              if (closed) break;
              continue;
            }
            if (next.kind === "outcome") break;
            if (next.kind === "error") {
              for (const synthetic of errorFrameToEvents(next.payload)) {
                state = applyTurnEvent(state, synthetic);
                yield synthetic;
              }
              break;
            }
            const ev = next.ev;
            debugLog("dialog.turn_event", { event: ev }, ctx());
            state = applyTurnEvent(state, ev);
            yield ev;
            if (ev.type === "completed") void refreshStatus();
            await yieldToEventLoop();
          }
        } finally {
          await pump.catch(() => undefined);
          debugLog(
            "dialog.turn_end",
            {
              input_kind: "elicitation",
              status: state.status,
              message_count: state.messages.length,
              tool_call_count: state.toolCalls.length,
              validation_error_count: state.validationErrors.length,
              assistant_text: lastAssistantText(state),
              pending_elicitation: state.pendingElicitation,
              usage: state.usage,
            },
            ctx(),
          );
        }
      }

      return {
        events: iterTurnEvents(),
        conversationId: currentConversationId,
      };
    } catch (err) {
      debugLog(
        "dialog.error",
        {
          input_kind: "elicitation",
          stage: "onElicitResponse",
          elicitation_id: elicitationId,
          output,
          reason: reason ?? null,
          error: serializeDebugError(err),
        },
        ctx(),
      );
      throw err;
    }
  };

  const onSelectConversation = async (id: string): Promise<void> => {
    currentConversationId = id;
    briefingContext = new AgentBriefingContext({
      profile: currentProfile,
      cwd: process.cwd(),
      sessionId: id,
    });
    initialContextStatus = (await briefingContext.start()).status;
    void refreshStatus();
  };

  const switchProfileFn = async (name: string): Promise<string> => {
    const cfg = loadConfig();
    const target = cfg.profiles[name];
    if (!target) return `profile "${name}" not found`;

    cfg.active_profile = name;
    saveConfig(cfg);

    const newProfile = resolveProfile({ profile: name });
    const newClient = new EngineClient({
      engine_url: newProfile.engine_url,
      api_key: newProfile.api_key,
      tenant: newProfile.active_tenant_id,
      user_agent: `sk-cli/${VERSION} (ink)`,
      debug_mode: "ink",
    });

    currentClient = newClient;
    currentProfile = newProfile;
    currentConversationId = null;
    briefingContext = new AgentBriefingContext({ profile: newProfile, cwd: process.cwd() });
    initialContextStatus = (await briefingContext.start()).status;
    bootSnapshot = { ...bootSnapshot, mentions: [] };
    for (const listener of bootSnapshotListeners) listener(bootSnapshot);

    let healthOk = true;
    try {
      await newClient.health();
    } catch {
      healthOk = false;
    }
    let nextPersona: ResolvedPersona;
    try {
      nextPersona = await resolvePersona(newClient, newProfile);
    } catch {
      nextPersona = fallbackPersona(newProfile);
    }
    if (currentClient !== newClient) {
      return `switch to "${name}" superseded by a newer /profile switch`;
    }
    pendingDigestContext = null;
    const [nextStatus, nextSetup, nextDigest, nextLearnings, nextMentions] = await Promise.all([
      newClient.statusSummary().catch(() => null),
      canReadSetup(nextPersona)
        ? newClient.setupValidation().catch(() => null)
        : Promise.resolve(null),
      fetchOperatorDigest(newClient),
      fetchPendingLearningsCount(newClient),
      loadMentionCandidates(newClient, nextPersona.allowed),
    ]);
    if (currentClient !== newClient) {
      return `switch to "${name}" superseded by a newer /profile switch`;
    }
    currentPersona = nextPersona;
    statusSnapshot = nextStatus;
    setupSnapshot = nextSetup;
    bootSnapshot = { digest: nextDigest, pendingLearnings: nextLearnings, mentions: nextMentions };
    pendingDigestContext = nextDigest ? digestAsContext(nextDigest) : null;
    profileVersion += 1;
    for (const listener of personaListeners) {
      listener({ persona: currentPersona, profile: newProfile, version: profileVersion });
    }
    for (const listener of statusListeners) listener(statusSnapshot);
    for (const listener of setupListeners) listener(setupSnapshot);
    for (const listener of bootSnapshotListeners) listener(bootSnapshot);

    return healthOk
      ? `switched to "${name}" (${newProfile.engine_url})`
      : `switched to "${name}" (${newProfile.engine_url}) — engine unreachable`;
  };

  const onSlash = async (
    name: string,
    raw: string,
    openPane: (spec: PaneSpec) => void,
    liveSession: SkSessionState,
  ): Promise<string | null> => {
    const rawArgs = raw.split(/\s+/).slice(1);
    const turn_id = newDebugTurnId("ink-slash");
    const ctx = (): DebugCorrelationFields => ({
      mode: "ink",
      conversation_id: liveSession.conversationId,
      turn_id,
    });
    debugLog("dialog.turn_start", { input_kind: "slash", name, raw_input: raw }, ctx());
    try {
      const line = await handleSlash(name, rawArgs, {
        client: currentClient,
        profile: currentProfile,
        session: liveSession,
        setConversationId: (next) => {
          currentConversationId = next;
          briefingContext = new AgentBriefingContext({
            profile: currentProfile,
            cwd: process.cwd(),
            ...(next ? { sessionId: next } : {}),
          });
          briefingReady = briefingContext.start();
          void briefingReady.then((update) => {
            initialContextStatus = update.status;
          });
        },
        allowedPermissions: Array.from(currentPersona.allowed ?? []),
        switchProfile: switchProfileFn,
        statusSnapshot,
        setupSnapshot,
        bootstrapSnapshot: currentPersona
          ? {
              fetchedAt: currentPersona.fetchedAt,
              source: currentPersona.source,
              label: currentPersona.label,
            }
          : null,
        openPane,
      });
      if (line !== null) {
        debugLog("dialog.render_output", { output_text: line }, ctx());
      }
      debugLog(
        "dialog.turn_end",
        { input_kind: "slash", name, status: "completed", output_text: line },
        ctx(),
      );
      return line;
    } catch (err) {
      const message = humanizeRequestError(err);
      debugLog(
        "dialog.error",
        {
          input_kind: "slash",
          name,
          raw_input: raw,
          error: serializeDebugError(err),
        },
        ctx(),
      );
      debugLog("dialog.render_output", { output_text: message }, ctx());
      debugLog(
        "dialog.turn_end",
        { input_kind: "slash", name, status: "error", output_text: message },
        ctx(),
      );
      return message;
    }
  };

  const pushNotifyOverride: { enabled?: boolean; thresholdMs?: number } = {};
  const envEnabledRaw = process.env.SK_PUSH_NOTIFY;
  if (envEnabledRaw === "1") pushNotifyOverride.enabled = true;
  else if (envEnabledRaw === "0") pushNotifyOverride.enabled = false;
  const rawThreshold = process.env.SK_PUSH_NOTIFY_THRESHOLD_MS?.trim() ?? "";
  if (/^\d+$/.test(rawThreshold)) {
    const envThreshold = Number.parseInt(rawThreshold, 10);
    if (envThreshold > 0) {
      pushNotifyOverride.thresholdMs = envThreshold;
    }
  }

  void fetchOperatorDigest(client).then((digest) => {
    if (currentClient !== client) return;
    bootSnapshot = { ...bootSnapshot, digest };
    if (digest) pendingDigestContext = digestAsContext(digest);
    for (const listener of bootSnapshotListeners) listener(bootSnapshot);
  });

  const RootApp: React.FC = () => {
    const [snap, setSnap] = React.useState<StatusSummary | null>(statusSnapshot);
    const [setup, setSetup] = React.useState<SetupValidationResponse | null>(setupSnapshot);
    const [conn, setConn] = React.useState<ConnectionSnapshot>(connectionSnapshot);
    const [boot, setBoot] = React.useState<OperatorBootSnapshot>(bootSnapshot);
    const [active, setActive] = React.useState<{
      persona: ResolvedPersona;
      profile: ResolvedProfile;
      version: number;
    }>({ persona: currentPersona, profile: opts.profile, version: profileVersion });
    React.useEffect(() => {
      const sl = (next: StatusSummary | null): void => setSnap(next);
      const pl = (next: {
        persona: ResolvedPersona;
        profile: ResolvedProfile;
        version: number;
      }): void => {
        setActive(next);
        setSnap(statusSnapshot);
        setSetup(setupSnapshot);
        setBoot(bootSnapshot);
      };
      const sul = (next: SetupValidationResponse | null): void => setSetup(next);
      const cl = (next: ConnectionSnapshot): void => setConn(next);
      const bl = (next: OperatorBootSnapshot): void => setBoot(next);
      statusListeners.add(sl);
      setupListeners.add(sul);
      personaListeners.add(pl);
      connectionListeners.add(cl);
      bootSnapshotListeners.add(bl);
      return () => {
        statusListeners.delete(sl);
        setupListeners.delete(sul);
        personaListeners.delete(pl);
        connectionListeners.delete(cl);
        bootSnapshotListeners.delete(bl);
      };
    }, []);
    return React.createElement(InkApp, {
      key: `app-${active.version}`,
      persona: {
        label: active.persona.label,
        tenant: active.persona.tenant ?? active.profile.active_tenant_id,
        engineUrl: active.profile.engine_url,
        profileName: active.profile.name,
        probe: active.persona.probe,
      },
      ...(settings.merged.statusLine ? { statusLineConfig: settings.merged.statusLine } : {}),
      ...(settings.merged.nextCommandPreviewEnabled !== undefined
        ? { nextCommandPreviewEnabled: settings.merged.nextCommandPreviewEnabled }
        : {}),
      initialConversationId: currentConversationId,
      initialContextStatus,
      model: settings.merged.model ?? null,
      cwd: process.cwd(),
      statusSnapshot: snap,
      setupSnapshot: setup,
      connectionSnapshot: conn,
      digestSnapshot: boot.digest,
      pendingLearningsCount: boot.pendingLearnings,
      onPrompt,
      onElicitResponse,
      onSlash,
      onSelectConversation,
      onCancelConversation: (id: string) => currentClient.cancelConversation(id),
      engineClient: currentClient,
      engineMentionCandidates: boot.mentions,
      prefs: active.persona.prefs,
      pushNotifyOverride,
    });
  };

  const restorePaste = enableBracketedPaste();
  const instance = ink.render(React.createElement(RootApp));
  try {
    await instance.waitUntilExit();
  } finally {
    pinger.stop();
    restorePaste();
  }
  return 0;
}
