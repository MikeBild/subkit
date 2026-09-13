// Unified error renderer.
//
// Replaces the four scattered error-rendering paths (the inline
// `humanizeRequestError` block in ink-app, the validation panel,
// the ToolCard failure block, and the prompt-error banner) with
// one component that:
//
//   - classifies the error into a known kind (rate-limit / validation
//     / network / engine / auth / generic)
//   - humanizes the headline via the existing `humanizeRequestError`
//     helpers
//   - shows the operator the *raw* envelope (code, hint, request_id)
//     in a dim row underneath, so debugging stays first-class
//   - renders a live retry countdown when the envelope carries
//     `retry_after`
//
// The countdown re-renders every second; it is purely cosmetic and
// does not actually retry — the caller decides whether to retry once
// the hint says it's safe.

import { useTheme } from "@chat-ui/index.ts";
import { isEngineError, isTransportError } from "@cli-core/errors.ts";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import {
  classifyEngineError,
  humanizeRequestError,
  type RawValidationError,
} from "../repl/error-humanize.ts";

export type ErrorPanelKind =
  "rate-limit" | "validation" | "network" | "engine" | "auth" | "generic";

export interface RateLimitPayload {
  message: string;
  retry_after?: number;
  hint?: string;
  request_id?: string;
}

export interface ValidationPayload {
  errors: RawValidationError[];
  hint?: string;
}

export interface NetworkPayload {
  message: string;
  hint?: string;
}

export interface EnginePayload {
  status: number;
  code: string;
  message: string;
  hint?: string;
  retry_after?: number;
  request_id?: string;
}

export interface AuthPayload {
  status: number;
  message: string;
  hint?: string;
}

export interface GenericPayload {
  message: string;
  hint?: string;
}

interface ErrorPanelPropsByKind {
  "rate-limit": RateLimitPayload;
  validation: ValidationPayload;
  network: NetworkPayload;
  engine: EnginePayload;
  auth: AuthPayload;
  generic: GenericPayload;
}

type ErrorPanelProps =
  | { kind: "rate-limit"; payload: RateLimitPayload; onRetry?: () => void; onDismiss?: () => void }
  | { kind: "validation"; payload: ValidationPayload; onRetry?: () => void; onDismiss?: () => void }
  | { kind: "network"; payload: NetworkPayload; onRetry?: () => void; onDismiss?: () => void }
  | { kind: "engine"; payload: EnginePayload; onRetry?: () => void; onDismiss?: () => void }
  | { kind: "auth"; payload: AuthPayload; onRetry?: () => void; onDismiss?: () => void }
  | { kind: "generic"; payload: GenericPayload; onRetry?: () => void; onDismiss?: () => void };

export function ErrorPanel(props: ErrorPanelProps): React.ReactElement {
  switch (props.kind) {
    case "rate-limit":
      return <RateLimitPanel payload={props.payload} />;
    case "validation":
      return <ValidationPanel payload={props.payload} />;
    case "network":
      return <NetworkPanel payload={props.payload} />;
    case "engine":
      return <EnginePanel payload={props.payload} />;
    case "auth":
      return <AuthPanel payload={props.payload} />;
    case "generic":
      return <GenericPanel payload={props.payload} />;
  }
}

function PanelHeader({
  icon,
  label,
  color,
}: {
  icon: string;
  label: string;
  color: string;
}): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text color={color} bold>
        {icon}
      </Text>
      <Text> </Text>
      <Text color={color} bold>
        {label}
      </Text>
    </Box>
  );
}

function HintRow({ hint }: { hint?: string | null | undefined }): React.ReactElement | null {
  const tokens = useTheme();
  if (!hint) return null;
  return (
    <Box paddingLeft={2}>
      <Text color={tokens.severity.dim}>↳ {hint}</Text>
    </Box>
  );
}

function MetaRow({
  parts,
}: {
  parts: Array<{ label: string; value: string } | null>;
}): React.ReactElement | null {
  const tokens = useTheme();
  const filtered = parts.filter((p): p is { label: string; value: string } => p !== null);
  if (filtered.length === 0) return null;
  return (
    <Box paddingLeft={2}>
      <Text color={tokens.severity.dim}>
        {filtered.map((p, i) => (
          <Text key={p.label}>
            {i > 0 ? " · " : ""}
            {p.label}={p.value}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function useCountdown(seconds: number | undefined): number | null {
  const [remaining, setRemaining] = useState<number | null>(
    typeof seconds === "number" ? seconds : null,
  );
  useEffect(() => {
    if (typeof seconds !== "number") {
      setRemaining(null);
      return undefined;
    }
    setRemaining(seconds);
    const interval = setInterval(() => {
      setRemaining((r) => (r == null ? null : Math.max(0, r - 1)));
    }, 1000);
    return () => clearInterval(interval);
  }, [seconds]);
  return remaining;
}

function RateLimitPanel({ payload }: { payload: RateLimitPayload }): React.ReactElement {
  const tokens = useTheme();
  const remaining = useCountdown(payload.retry_after);
  return (
    <Box flexDirection="column" marginTop={1}>
      <PanelHeader icon="●" label="rate limit" color={tokens.severity.warning} />
      <Box paddingLeft={2}>
        <Text color={tokens.severity.warning}>{payload.message}</Text>
      </Box>
      {remaining != null ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>
            retry available in {remaining}s {remaining === 0 ? "(now)" : ""}
          </Text>
        </Box>
      ) : null}
      <HintRow hint={payload.hint} />
      <MetaRow
        parts={[payload.request_id ? { label: "trace", value: payload.request_id } : null]}
      />
    </Box>
  );
}

function ValidationPanel({ payload }: { payload: ValidationPayload }): React.ReactElement {
  const tokens = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <PanelHeader icon="✗" label="validation errors" color={tokens.severity.error} />
      {payload.errors.slice(0, 8).map((e, idx) => {
        const kind = classifyEngineError(e);
        const headerColor =
          kind === "provider_limit" || kind === "provider_unavailable"
            ? tokens.severity.warning
            : tokens.severity.error;
        return (
          <Box key={`${e.path}-${idx}`} flexDirection="column">
            <Box paddingLeft={2}>
              <Text color={headerColor}>{e.message}</Text>
            </Box>
            <Box paddingLeft={4}>
              <Text color={tokens.severity.dim}>{e.path}</Text>
            </Box>
          </Box>
        );
      })}
      {payload.errors.length > 8 ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>(+{payload.errors.length - 8} more)</Text>
        </Box>
      ) : null}
      <HintRow hint={payload.hint} />
    </Box>
  );
}

function NetworkPanel({ payload }: { payload: NetworkPayload }): React.ReactElement {
  const tokens = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <PanelHeader icon="⟂" label="network error" color={tokens.severity.warning} />
      <Box paddingLeft={2}>
        <Text color={tokens.severity.warning}>{payload.message}</Text>
      </Box>
      <HintRow
        hint={payload.hint ?? "check that the engine is reachable, then re-run the prompt"}
      />
    </Box>
  );
}

function EnginePanel({ payload }: { payload: EnginePayload }): React.ReactElement {
  const tokens = useTheme();
  const remaining = useCountdown(payload.retry_after);
  return (
    <Box flexDirection="column" marginTop={1}>
      <PanelHeader
        icon="✗"
        label={`engine error · HTTP ${payload.status} ${payload.code}`}
        color={tokens.severity.error}
      />
      <Box paddingLeft={2}>
        <Text color={tokens.severity.error}>{payload.message}</Text>
      </Box>
      {remaining != null ? (
        <Box paddingLeft={2}>
          <Text color={tokens.severity.dim}>
            retry available in {remaining}s {remaining === 0 ? "(now)" : ""}
          </Text>
        </Box>
      ) : null}
      <HintRow hint={payload.hint} />
      <MetaRow
        parts={[payload.request_id ? { label: "trace", value: payload.request_id } : null]}
      />
    </Box>
  );
}

function AuthPanel({ payload }: { payload: AuthPayload }): React.ReactElement {
  const tokens = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <PanelHeader icon="⚿" label={`auth · HTTP ${payload.status}`} color={tokens.severity.error} />
      <Box paddingLeft={2}>
        <Text color={tokens.severity.error}>{payload.message}</Text>
      </Box>
      <HintRow hint={payload.hint ?? "run `sk login` again to refresh credentials"} />
    </Box>
  );
}

function GenericPanel({ payload }: { payload: GenericPayload }): React.ReactElement {
  const tokens = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <PanelHeader icon="✗" label="error" color={tokens.severity.error} />
      <Box paddingLeft={2}>
        <Text color={tokens.severity.error}>{payload.message}</Text>
      </Box>
      <HintRow hint={payload.hint} />
    </Box>
  );
}

/**
 * Classify a raw error into one of the known panel kinds + payload.
 * Centralizes the routing logic so call-sites just say
 * `<ErrorPanel {...errorToPanel(err)} />`.
 */
// Name-based guards live in @cli-core/errors (robust to the parallel
// bun test runner loading a module twice and yielding two distinct
// class identities).

/**
 * Classify a top-level error into a panel kind. This is intentionally
 * a *different axis* from `classifyEngineError`:
 *
 * - `errorToPanel` switches on **transport / status** — `429` →
 *   rate-limit panel, `401/403` → auth panel, transport errors →
 *   network panel, `422` with an `errors` array → validation panel,
 *   everything else → generic engine panel. This decides which panel
 *   *shell* to render.
 *
 * - `classifyEngineError` switches on **per-row semantic content** —
 *   given a single `RawValidationError`, it labels the row as
 *   `provider_limit` / `provider_unavailable` / `validation` so the
 *   ValidationPanel can colour individual rows. The validation panel
 *   already consumes that classifier internally; `errorToPanel` does
 *   not duplicate it, it simply picks the panel.
 *
 * Both surfaces stay thin: the only branching done here is on `status`.
 */
export function errorToPanel(err: unknown): {
  kind: ErrorPanelKind;
  payload: ErrorPanelPropsByKind[ErrorPanelKind];
} {
  if (isEngineError(err)) {
    if (err.status === 429) {
      const payload: RateLimitPayload = {
        message: err.message,
        ...(err.retry_after != null ? { retry_after: err.retry_after } : {}),
        ...(err.hint ? { hint: err.hint } : {}),
        ...(err.trace_id ? { request_id: err.trace_id } : {}),
      };
      return { kind: "rate-limit", payload };
    }
    if (err.status === 401 || err.status === 403) {
      const payload: AuthPayload = {
        status: err.status,
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
      };
      return { kind: "auth", payload };
    }
    // 422 with a structured `errors` array routes to the validation
    // panel so per-row severity (via the row classifier) can fire.
    // Other 4xx/5xx fall through to the generic engine panel.
    if (err.status === 422 && hasValidationErrors(err.details)) {
      const payload: ValidationPayload = {
        errors: err.details.errors,
        ...(err.hint ? { hint: err.hint } : {}),
      };
      return { kind: "validation", payload };
    }
    const payload: EnginePayload = {
      status: err.status,
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.retry_after != null ? { retry_after: err.retry_after } : {}),
      ...(err.trace_id ? { request_id: err.trace_id } : {}),
    };
    return { kind: "engine", payload };
  }
  if (isTransportError(err)) {
    return {
      kind: "network",
      payload: { message: err.message },
    };
  }
  // Last-resort fallback uses the existing humanize helper so we keep
  // parity with the legacy renderer.
  return {
    kind: "generic",
    payload: { message: humanizeRequestError(err) },
  };
}

function hasValidationErrors(details: unknown): details is { errors: RawValidationError[] } {
  if (!details || typeof details !== "object") return false;
  const errs = (details as { errors?: unknown }).errors;
  if (!Array.isArray(errs)) return false;
  return errs.every(
    (e) =>
      e &&
      typeof e === "object" &&
      typeof (e as { path?: unknown }).path === "string" &&
      typeof (e as { message?: unknown }).message === "string",
  );
}

/**
 * Pull a single-line "body" string out of any panel kind. Centralises
 * the union narrowing so call sites that want to surface an error
 * elsewhere (toast queue, status line, log row) don't reach into the
 * payload with double `as`-casts.
 */
export function bodyOf(panel: { kind: ErrorPanelKind; payload: unknown }): string {
  switch (panel.kind) {
    case "rate-limit":
    case "network":
    case "engine":
    case "auth":
    case "generic":
      return (panel.payload as { message: string }).message;
    case "validation": {
      const errors = (panel.payload as ValidationPayload).errors;
      return errors[0]?.message ?? "validation error";
    }
  }
}
