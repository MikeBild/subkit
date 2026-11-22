import { z } from "zod";

export const PROBLEM_FOLD_MS = 5 * 60_000;

export const RUNNER_PROBLEM_SCOPES = ["claim", "delivery", "ledger"] as const;
export const ERROR_CLASSES = ["http", "network", "invalid_answer", "unexpected"] as const;

export const RunnerProblemSchema = z
  .object({
    scope: z.enum(RUNNER_PROBLEM_SCOPES),
    error_class: z.enum(ERROR_CLASSES),
    status: z.number().int().min(100).max(599).nullable(),
    repeats: z.number().int().nonnegative(),
  })
  .strict();
export type RunnerProblem = z.infer<typeof RunnerProblemSchema>;
export type ProblemEvent = Omit<RunnerProblem, "repeats">;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

interface Folded {
  readonly reported_at: number;
  readonly repeats: number;
}

export type ProblemFold = ReadonlyMap<string, Folded>;

export const EMPTY_PROBLEM_FOLD: ProblemFold = new Map();

export function problemKey(event: ProblemEvent): string {
  return `${event.scope}:${event.error_class}:${event.status ?? "-"}`;
}

export function foldProblem(
  fold: ProblemFold,
  event: ProblemEvent,
  now: number,
): { fold: ProblemFold; emit: RunnerProblem | null } {
  const key = problemKey(event);
  const known = fold.get(key);
  const next = new Map(fold);
  if (known && now - known.reported_at < PROBLEM_FOLD_MS) {
    next.set(key, { reported_at: known.reported_at, repeats: known.repeats + 1 });
    return { fold: next, emit: null };
  }
  next.set(key, { reported_at: now, repeats: 0 });
  return { fold: next, emit: { ...event, repeats: known?.repeats ?? 0 } };
}

export function errorClassOf(error: { name: string; status: number | null }): ErrorClass {
  if (error.status !== null) return "http";
  if (error.name === "TypeError") return "network";
  if (error.name === "SyntaxError" || error.name === "ZodError") return "invalid_answer";
  return "unexpected";
}

export function problemLine(problem: RunnerProblem): string {
  const what =
    problem.status === null ? problem.error_class : `${problem.error_class} ${problem.status}`;
  return problem.repeats === 0
    ? `${what} failed`
    : `${what} failed, ${problem.repeats} more times since the last entry`;
}
