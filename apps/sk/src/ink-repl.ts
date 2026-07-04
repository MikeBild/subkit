// Bridge between apps/sk's engine client + the Ink rich REPL.
//
// Exposes a single `runInkRepl(profile, opts)` that:
//
//   1. Probes the caller's permissions via /v1/rbac/can + /whoami.
//   2. Lazily imports ink + React so `sk -p "..."` never loads them.
//   3. Renders <InkApp> with onPrompt / onSlash / onElicitResponse
//      callbacks wired to the EngineClient and the sessions cache.
//   4. Waits for the app to exit.
//
// When the caller requests the REPL but stdout is NOT a TTY (e.g.
// piped into a file), we fall back to the readline REPL so scripts
// still see line-based output.

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
  type SetupValidationResponse,
  type StatusSummary,
} from "./engine-client.ts";
import { loadMemory } from "./memory.ts";
import { resolveMentions } from "./mentions.ts";
import { enableBracketedPaste } from "./repl/bracketed-paste.ts";
import { humanizeRequestError } from "./repl/error-humanize.ts";
import { type ResolvedPersona, resolvePersona } from "./repl/resolved-persona.ts";
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

export async function runInkRepl(opts: InkReplOptions): Promise<number> {
  // Fall back to the readline REPL when stdout is not a TTY — Ink
  // cannot render sensibly into a pipe and `bun test` drives us
  // without a TTY for smoke tests.
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

  // One-shot operator-digest context. Set when the startup health check
  // surfaces open issues; folded into the FIRST conversation turn's
  // memory so replying "yes" grounds the LLM in the same digest, then
  // cleared so later turns aren't re-seeded.
  let pendingDigestContext: string | null = null;
  // Live operator-digest snapshot for the in-context chrome. Refreshed on
  // every /profile switch so the panel and first-turn memory always describe
  // the ACTIVE tenant — never tenant-A's failures leaking into tenant-B.
  let operatorDigestSnapshot: OperatorHealthDigest | null = null;

  const client = new EngineClient({
    engine_url: opts.profile.engine_url,
    api_key: opts.profile.api_key,
    tenant: opts.profile.active_tenant_id,
    user_agent: `sk-cli/${VERSION} (ink)`,
    debug_mode: "ink",
  });

  const canReadSetup = (persona: ResolvedPersona): boolean =>
    persona.allowed.has("audit:read") || persona.allowed.has("identity:read");

  // Boot round-trips overlap instead of serializing: status starts
  // before the persona resolution, setup validation starts the moment
  // the persona (its permission gate) is known, and both are awaited
  // only AFTER the heavy react/ink dynamic imports — the network waits
  // and the module loads pay for each other.
  const statusPromise = client.statusSummary().catch(() => null);
  let currentPersona = await resolvePersona(client, opts.profile);
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
  // Bumped on every successful /profile switch so RootApp can remount
  // <InkApp> with a fresh `key` — fresh session state, fresh
  // conversationId, fresh status snapshot. Without this the engine URL
  // and tenant in the status bar lag behind the active client.
  let profileVersion = 0;
  const personaListeners = new Set<
    (snap: { persona: ResolvedPersona; profile: ResolvedProfile; version: number }) => void
  >();

  // Composite status snapshot (connector count, tokens today, tenant
  // slug, monthly budget). Fetched once on mount, then refreshed after
  // every completed turn via `refreshStatus()` so the status-line
  // ticker always shows fresh numbers.
  let statusSnapshot: StatusSummary | null = await statusPromise;
  const statusListeners = new Set<(snap: StatusSummary | null) => void>();
  let setupSnapshot: SetupValidationResponse | null = await setupPromise;
  const setupListeners = new Set<(snap: SetupValidationResponse | null) => void>();
  const digestListeners = new Set<(snap: OperatorHealthDigest | null) => void>();
  const refreshStatus = async (): Promise<void> => {
    try {
      statusSnapshot = await currentClient.statusSummary();
    } catch {
      // Leave the previous value in place on transient failures; the
      // status line stays usable (with the last-known numbers) instead
      // of flickering to blanks. The ConnectionPinger surfaces the
      // outage state separately so the operator sees something.
    }
    for (const listener of statusListeners) listener(statusSnapshot);
  };

  // Live health pinger — drives the online/offline chip in the status
  // line so the operator notices a dropped engine within ~15s instead
  // of waiting for a visible tool failure.
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
    promptOpts?: { permission_mode?: "auto" | "ask" | "plan" | "yolo" },
  ): Promise<{ events: AsyncIterable<TurnEvent>; conversationId: string }> => {
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
          warnings: resolved.warnings,
        },
        baseCtx(),
      );
      for (const warning of resolved.warnings) {
        debugLog("dialog.warning", { warning }, baseCtx());
      }
      // Drive the turn over a live SSE stream so the Ink app paints
      // each tool_call_start / tool_result / text_delta the moment the
      // engine emits it, instead of waiting ~10–30s for the entire
      // turn (multi-tool authoring sessions) to flush as one JSON body.
      //
      // The engine's POST handlers content-negotiate on
      // `Accept: text/event-stream`. Frames carry the same TurnEvent
      // payloads as the JSON `events[]`; two SSE-only meta events
      // (`conversation_started`, `outcome`) bracket the turn so the
      // client learns the conversation_id up-front (on create) and
      // captures the final status without re-reading any state.
      const operation: "create_conversation" | "append_message" = currentConversationId
        ? "append_message"
        : "create_conversation";
      const isCreate = operation === "create_conversation";
      // Fold the one-shot operator-digest context into the first turn's
      // memory, then consume it so it never re-seeds a later turn.
      const turnMemory =
        isCreate && pendingDigestContext
          ? [memory.content, pendingDigestContext].filter(Boolean).join("\n\n---\n\n")
          : memory.content;
      pendingDigestContext = null;
      const stream = isCreate
        ? await currentClient.createConversationStream(
            {
              initial_message: resolved.prompt,
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
              ...(memory.content ? { memory: memory.content } : {}),
              ...(promptOpts?.permission_mode
                ? { permission_mode: promptOpts.permission_mode }
                : {}),
            },
            baseCtx(),
          );

      // Buffer/queue handoff: readSse fires per-frame callbacks while
      // the Ink app pulls events via async iterator. We push parsed
      // TurnEvents (and surface the create-time conversation_id /
      // terminal outcome) into a queue, then yield them in order.
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
      // Resolved as soon as we know the conversation_id — immediately
      // for an append turn (we already have it), after the
      // `conversation_started` frame for a create turn. onPrompt awaits
      // this so the Ink app sees the populated conversationId before
      // it starts consuming events.
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
            } catch {
              /* ignore */
            }
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
            // Surface readiness even on early failure so onPrompt can
            // proceed to the iterator (which yields the synthesised
            // validation_error).
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
        // Coalesce-drain bookkeeping: text_delta and tool_call_*
        // frames can arrive in tight bursts (~10ms apart). Yielding
        // each one back-to-back keeps Ink stuck in the same React
        // batch and the user sees no incremental paint between frames.
        // After every yield we surrender the event loop with
        // setImmediate so Ink can flush stdout for the previous
        // setSession before we hand it the next one.
        const yieldToEventLoop = () =>
          new Promise<void>((resolve) => {
            // setImmediate runs after I/O callbacks, giving Ink's
            // render-then-write pipeline a turn before the next event.
            // Falls back to setTimeout(0) on runtimes without it.
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
              // `pending_elicitation_blocked` carries the still-open
              // dialog — errorFrameToEvents replays it as an
              // elicit_request so the session restores the dialog
              // instead of deadlocking.
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
            // Surrender the event loop so Ink can paint the setSession
            // triggered by the consumer before we hand it the next
            // frame. Without this, React batches a burst of frames
            // into one render and the user sees the bubble appear
            // pre-filled instead of growing token by token.
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
      // Stream the resumed turn over SSE so the operator sees each
      // tool_call_start / tool_result / text_delta as it lands. Pre-fix
      // this path used the JSON-only `respondElicitation` and the
      // entire 1–2 minute resumed turn buffered server-side before
      // anything painted — the user saw `summarising N tool results ·
      // 1m43s` for the whole thing (session 927d0835).
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

    // Re-resolve persona against the new client so the status bar gets
    // the new tenant slug + RBAC label, then refresh the status snapshot
    // so token / connector counts come from the new engine. Both run
    // best-effort — even if the engine is unreachable we still publish
    // the new engineUrl + profileName so the UI reflects the switch.
    let healthOk = true;
    try {
      await newClient.health();
    } catch {
      healthOk = false;
    }
    try {
      currentPersona = await resolvePersona(newClient, newProfile);
    } catch {
      // Fall back to a minimal persona keyed off the profile so the
      // footer at least shows the right engine + profile name.
      currentPersona = {
        label: newProfile.persona_hint ?? "user",
        probe: { allows: () => false },
        allowed: new Set(),
        tenant: newProfile.active_tenant_id ?? null,
        email: null,
        fetchedAt: Date.now(),
        source: "fallback",
        prefs: {
          permissionMode: "ask",
          theme: "auto",
          personality: "balanced",
          titleFormat: "session-id",
          statuslineFormat: "compact",
          pushNotifyEnabled: false,
          pushNotifyThresholdSec: 30,
          quietHoursStart: "",
          quietHoursEnd: "",
          portalTokenTtlMin: 15,
        },
      };
    }
    // Re-seed the digest for the NEW tenant. Clearing first guarantees
    // tenant-A's failures/context can never render (chrome) or fold into
    // tenant-B's first turn (memory) if the refetch fails. Best-effort,
    // like the boot-time call — and fetched CONCURRENTLY with status +
    // setup so the switch pays one round-trip, not three.
    pendingDigestContext = null;
    [statusSnapshot, setupSnapshot, operatorDigestSnapshot] = await Promise.all([
      newClient.statusSummary().catch(() => null),
      canReadSetup(currentPersona)
        ? newClient.setupValidation().catch(() => null)
        : Promise.resolve(null),
      fetchOperatorDigest(newClient),
    ]);
    if (operatorDigestSnapshot) {
      pendingDigestContext = digestAsContext(operatorDigestSnapshot);
    }
    profileVersion += 1;
    for (const listener of personaListeners) {
      listener({ persona: currentPersona, profile: newProfile, version: profileVersion });
    }
    for (const listener of statusListeners) listener(statusSnapshot);
    for (const listener of setupListeners) listener(setupSnapshot);
    for (const listener of digestListeners) listener(operatorDigestSnapshot);

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
        },
        allowedPermissions: Array.from(currentPersona.allowed ?? []),
        switchProfile: switchProfileFn,
        statusSnapshot,
        setupSnapshot,
        // Pass the bootstrap snapshot so /status surfaces
        // source + age. `currentPersona` is the materialised
        // SkBootstrapSnapshot resolved on REPL startup.
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

  // Read the per-process push-notify overrides exactly once at REPL
  // boot. Sampling the env inside `applyEventStream` on every turn
  // would let an `export SK_PUSH_NOTIFY=1` silently change behavior
  // mid-REPL. Reading once here keeps the override aligned with the
  // rest of the boot-time wiring; operators who need to flip it
  // without restarting should switch the engine-side
  // `notifications.push.*` setting through `/settings → Notifications`.
  const pushNotifyOverride: { enabled?: boolean; thresholdMs?: number } = {};
  const envEnabledRaw = process.env.SK_PUSH_NOTIFY;
  if (envEnabledRaw === "1") pushNotifyOverride.enabled = true;
  else if (envEnabledRaw === "0") pushNotifyOverride.enabled = false;
  // Require pure decimal digits. `Number("0xff")` returns 255
  // (silently accepts hex); `Number("12px")` returns NaN (caught by
  // isFinite, but not the pattern we want to encode). The /^\d+$/
  // test rejects both before parseInt. Empty/missing → no override.
  const rawThreshold = process.env.SK_PUSH_NOTIFY_THRESHOLD_MS?.trim() ?? "";
  if (/^\d+$/.test(rawThreshold)) {
    const envThreshold = Number.parseInt(rawThreshold, 10);
    if (envThreshold > 0) {
      pushNotifyOverride.thresholdMs = envThreshold;
    }
  }

  // The operator digest is chrome + first-turn seeding, not
  // boot-critical: fetch it in the background so first paint never
  // waits on it. When it lands, the digest listeners re-render the
  // chrome and `pendingDigestContext` seeds the NEXT turn's memory —
  // an operator faster than the digest simply gets an unseeded first
  // turn, which matches the digest's best-effort contract.
  void fetchOperatorDigest(client).then((digest) => {
    operatorDigestSnapshot = digest;
    if (digest) pendingDigestContext = digestAsContext(digest);
    for (const listener of digestListeners) listener(digest);
  });

  // Small root wrapper that subscribes to status + persona updates and
  // feeds the latest snapshots into <InkApp> as props. The `key` is
  // bumped on every /profile switch so React fully remounts the app —
  // session, conversationId, and InkApp's local state are all reset
  // together with the engineUrl + tenant in the status bar.
  const RootApp: React.FC = () => {
    const [snap, setSnap] = React.useState<StatusSummary | null>(statusSnapshot);
    const [setup, setSetup] = React.useState<SetupValidationResponse | null>(setupSnapshot);
    const [conn, setConn] = React.useState<ConnectionSnapshot>(connectionSnapshot);
    const [digest, setDigest] = React.useState<OperatorHealthDigest | null>(operatorDigestSnapshot);
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
        setDigest(operatorDigestSnapshot);
      };
      const sul = (next: SetupValidationResponse | null): void => setSetup(next);
      const cl = (next: ConnectionSnapshot): void => setConn(next);
      const dl = (next: OperatorHealthDigest | null): void => setDigest(next);
      statusListeners.add(sl);
      setupListeners.add(sul);
      personaListeners.add(pl);
      connectionListeners.add(cl);
      digestListeners.add(dl);
      return () => {
        statusListeners.delete(sl);
        setupListeners.delete(sul);
        personaListeners.delete(pl);
        connectionListeners.delete(cl);
        digestListeners.delete(dl);
      };
    }, []);
    return React.createElement(InkApp, {
      key: `app-${active.version}`,
      persona: {
        label: active.persona.label,
        // Prefer the whoami-resolved tenant (slug) over the profile's
        // stored uuid — it's what the user typed and recognizes.
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
      model: settings.merged.model ?? null,
      cwd: process.cwd(),
      statusSnapshot: snap,
      setupSnapshot: setup,
      connectionSnapshot: conn,
      digestSnapshot: digest,
      onPrompt,
      onElicitResponse,
      onSlash,
      onSelectConversation,
      onCancelConversation: (id: string) => currentClient.cancelConversation(id),
      // The embedded /settings pane needs an EngineClient to fetch
      // the settings list. Pass the active client through so the
      // modal renders inside the REPL with REPL state.
      engineClient: currentClient,
      // Pass the engine-resolved push/notification prefs so
      // applyEventStream can call notify() without an env-var hop.
      // On older engines the snapshot's prefs come from `fromLegacy()`
      // defaults.
      prefs: active.persona.prefs,
      // Per-process env override sampled exactly once at REPL boot.
      // See declaration above.
      pushNotifyOverride,
    });
  };

  // Enable bracketed paste mode before mounting Ink so terminal wraps
  // multi-line pastes with ESC[200~/ESC[201~ markers — the input
  // handler strips them back out to re-assemble the original text.
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
