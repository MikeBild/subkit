// Authoring-critic gating predicate.
//
// Critic calls cost real tokens; this predicate gates the second-stage
// pass so trivial drafts (one or two steps) don't pay the price, and
// a stuck conversation doesn't loop on the same rejection forever.
//
// All thresholds are read at runtime from the runtime config via
// `getConfig().llm.critic`. Operators set them through
// `sk settings configure` (per-tenant when applicable) — there are
// NO feature-flag environment variables. The standard
// Canonical llm.critic.* runtime configuration remains hot-reloadable
// for incident response without restarts.
//
// Run gate:
//   (a) `enabled` AND `consecutive_rejections < max` AND
//   (b) draft step count >= `min_steps` OR there was drift in recent drafts.

import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/logger.ts";

interface CriticConfig {
  enabled: boolean;
  min_steps: number;
  max_consecutive_rejections: number;
}

// Warn on a 60 s throttle when the config loader is unreachable.
// Without this signal a production misconfig that throws inside
// `getConfig()` silently makes the critic look disabled — operators
// would lose time debugging "critic isn't running" against a config
// that visibly says `enabled:true`. A throttle (vs. one-shot) lets a
// hot-reload that briefly loses and regains the config refire the
// warning instead of staying mute for the rest of the process.
const CONFIG_MISS_WARN_THROTTLE_MS = 60_000;
let lastConfigMissWarnedAt = 0;

function readConfig(tenantId?: string): CriticConfig {
  try {
    // Pass `tenantId` so the loader applies any per-tenant overlay on
    // the `llm.critic.*` leaves — the schema marks them `tenant()`
    // scope, and operators flip them via
    // `sk settings configure --tenant <id>`. Without the tenant id,
    // the global value wins and the overlay is silently ignored.
    const cfg = getConfig(tenantId).llm.critic;
    return {
      enabled: cfg.enabled,
      min_steps: cfg.min_steps,
      max_consecutive_rejections: cfg.max_consecutive_rejections,
    };
  } catch (err) {
    const now = Date.now();
    if (now - lastConfigMissWarnedAt >= CONFIG_MISS_WARN_THROTTLE_MS) {
      lastConfigMissWarnedAt = now;
      logger.warn({
        module: "conversations",
        action: "critic.config_unavailable",
        msg: "authoring critic config could not be read; defaulting to disabled",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Loader not initialised (unit tests that don't bootstrap config).
    // Default off — same as the schema default — so the critic is
    // never silently active in a test that forgot to wire config.
    return { enabled: false, min_steps: 3, max_consecutive_rejections: 3 };
  }
}

export interface GatingInput {
  /** Number of steps in the candidate draft. */
  stepCount: number;
  /** Count of dry-run warnings observed on the most recent preview, if any. */
  recentDriftCount: number;
  /** Count of consecutive `critic_rejected` results in the conversation's
   *  recent tool calls. Used to short-circuit a stuck re-author loop. */
  consecutiveRejections: number;
  /** Tenant id — required to honour per-tenant overlays on the
   *  `llm.critic.*` config block. When omitted, the global value
   *  wins (the schema default is `enabled:false`). */
  tenantId?: string;
}

export interface GatingDecision {
  /** True when the critic should be invoked. */
  run: boolean;
  /** Short tag for telemetry: why the decision was made. */
  reason: "disabled" | "anti_loop" | "step_count" | "recent_drift" | "below_threshold";
}

/**
 * Pure gating predicate. Reads config but never the DB; safe to call
 * from inside tool execution.
 */
export function shouldRunCritic(input: GatingInput): GatingDecision {
  const cfg = readConfig(input.tenantId);
  if (!cfg.enabled) {
    return { run: false, reason: "disabled" };
  }
  if (input.consecutiveRejections >= cfg.max_consecutive_rejections) {
    return { run: false, reason: "anti_loop" };
  }
  if (input.stepCount >= cfg.min_steps) {
    return { run: true, reason: "step_count" };
  }
  if (input.recentDriftCount > 0) {
    return { run: true, reason: "recent_drift" };
  }
  return { run: false, reason: "below_threshold" };
}
