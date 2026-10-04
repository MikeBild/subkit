export type FailureClass =
  | "transient_network"
  | "transient_5xx"
  | "rate_limited"
  | "auth_failure"
  | "permanent_4xx"
  | "unknown";

export interface ClassifyFailureInput {
  status: number;
  error: string | null;
}

export function classifyFailure(input: ClassifyFailureInput): FailureClass {
  const { status, error } = input;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failure";
  if (status >= 500 && status <= 599) return "transient_5xx";
  if (status >= 400 && status <= 499) return "permanent_4xx";
  if (!status && error) return "transient_network";
  return "unknown";
}

export function isPermanentFailure(cls: FailureClass): boolean {
  return cls === "permanent_4xx" || cls === "auth_failure";
}
