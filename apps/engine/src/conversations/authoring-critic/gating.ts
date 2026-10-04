import { getConfig } from "../../config/loader.ts";
import { logger } from "../../logging/logger.ts";

interface CriticConfig {
  enabled: boolean;
  min_steps: number;
  max_consecutive_rejections: number;
}

const CONFIG_MISS_WARN_THROTTLE_MS = 60_000;
let lastConfigMissWarnedAt = 0;

function readConfig(tenantId?: string): CriticConfig {
  try {
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
    return { enabled: false, min_steps: 3, max_consecutive_rejections: 3 };
  }
}

export interface GatingInput {
  stepCount: number;
  recentDriftCount: number;
  consecutiveRejections: number;
  tenantId?: string;
}

export interface GatingDecision {
  run: boolean;
  reason: "disabled" | "anti_loop" | "step_count" | "recent_drift" | "below_threshold";
}

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
