// Single source of truth for the engine's six log levels and their
// pretty-print colors. Both the engine logger (server-side stdout)
// and the `sk logs` pretty renderer (operator side) consume these
// so a level rename or color tweak only touches one place
// (review S6).

import pc from "picocolors";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export const LOG_LEVEL_WEIGHT: Record<LogLevelName, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export function logLevelWeight(level: string): number {
  const key = level.toLowerCase() as LogLevelName;
  return LOG_LEVEL_WEIGHT[key] ?? 0;
}

/**
 * Color a level token for terminal output. Keep in lockstep with the
 * engine logger's `colorLevel` (apps/engine/src/logging/logger.ts) so
 * boot logs and `sk logs` render identically.
 */
export function colorizeLogLevel(level: string, text = level.toUpperCase().padEnd(5)): string {
  switch (level.toLowerCase() as LogLevelName) {
    case "trace":
      return pc.gray(text);
    case "debug":
      return pc.cyan(text);
    case "info":
      return pc.green(text);
    case "warn":
      return pc.yellow(text);
    case "error":
      return pc.red(text);
    case "fatal":
      return pc.bgRed(pc.white(text));
    default:
      return text;
  }
}
