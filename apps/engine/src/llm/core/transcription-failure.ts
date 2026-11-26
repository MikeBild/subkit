export type TranscriptionAttempt =
  | { readonly phase: "unsent" }
  | { readonly phase: "sent" }
  | { readonly phase: "answered"; readonly status: number };

export type TranscriptionFailureOutcome = "release" | "reconcile";

export type AttemptFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const UNSENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

const codeOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "code" in value ? value.code : undefined;

export const neverSent = (error: unknown): boolean =>
  [error, error instanceof Error ? error.cause : undefined].some((candidate) => {
    const code = codeOf(candidate);
    return typeof code === "string" && UNSENT_CODES.has(code);
  });

export class TranscriptionDispatchError extends Error {
  constructor(
    cause: unknown,
    readonly attempts: readonly TranscriptionAttempt[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TranscriptionDispatchError";
  }
}

export function recordingFetch(attempts: TranscriptionAttempt[], base: AttemptFetch): AttemptFetch {
  return async (input, init) => {
    const index = attempts.push({ phase: "sent" }) - 1;
    try {
      const response = await base(input, init);
      attempts[index] = { phase: "answered", status: response.status };
      return response;
    } catch (error) {
      if (neverSent(error)) attempts[index] = { phase: "unsent" };
      throw error;
    }
  };
}

export const attemptOutcome = (attempt: TranscriptionAttempt): TranscriptionFailureOutcome =>
  attempt.phase === "unsent" ||
  (attempt.phase === "answered" && attempt.status >= 400 && attempt.status < 500)
    ? "release"
    : "reconcile";

export const transcriptionFailureOutcome = (error: unknown): TranscriptionFailureOutcome =>
  error instanceof TranscriptionDispatchError &&
  error.attempts.every((attempt) => attemptOutcome(attempt) === "release")
    ? "release"
    : "reconcile";
