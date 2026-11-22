import {
  EMPTY_PROBLEM_FOLD,
  errorClassOf,
  foldProblem,
  type ProblemFold,
  type RunnerProblem,
} from "../shared/local/runner-problems.ts";
import { ChannelError } from "./channel.ts";

export interface ReportPort {
  failed(scope: RunnerProblem["scope"], error: unknown): void;
}

export interface ProblemReporterOptions {
  now: () => number;
  emit: (problem: RunnerProblem) => void;
}

export function createProblemReporter(options: ProblemReporterOptions): ReportPort {
  let fold: ProblemFold = EMPTY_PROBLEM_FOLD;
  return {
    failed(scope, error) {
      const status = error instanceof ChannelError ? error.status : null;
      const name = error instanceof Error ? error.name : "unknown";
      const next = foldProblem(
        fold,
        { scope, error_class: errorClassOf({ name, status }), status },
        options.now(),
      );
      fold = next.fold;
      if (next.emit) options.emit(next.emit);
    },
  };
}
