import { apiUrl } from "./clipper.ts";
import type { IntakeItem, IntakeSubmission } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly traceId: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class CollectionPermissionError extends Error {
  constructor() {
    super("intake:write is not allowed");
    this.name = "CollectionPermissionError";
  }
}

export function connectionErrorMessage(
  error: unknown,
  copy: {
    invalidApiKey: string;
    missingIntakeReadPermission: string;
    missingIntakeWritePermission: string;
    connectionFailed: string;
    apiResponseFailed: string;
  },
): string {
  if (error instanceof CollectionPermissionError) return copy.missingIntakeWritePermission;
  if (error instanceof ApiError) {
    if (error.status === 401) return copy.invalidApiKey;
    if (error.status === 403) return copy.missingIntakeReadPermission;
    return `${copy.apiResponseFailed} (HTTP ${error.status}${error.traceId ? `, Trace: ${error.traceId}` : ""})`;
  }
  return copy.connectionFailed;
}

export class CollectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionInputError";
  }
}

export function collectionErrorMessage(
  error: unknown,
  copy: Parameters<typeof connectionErrorMessage>[1] & {
    collectionRejected: string;
    duplicate: string;
  },
): string {
  if (error instanceof CollectionInputError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 401) return copy.invalidApiKey;
    if (error.status === 403) return copy.missingIntakeWritePermission;
    if ([400, 422].includes(error.status)) return copy.collectionRejected;
    if (error.status === 409) return copy.duplicate;
    return `${copy.apiResponseFailed} (HTTP ${error.status}${error.traceId ? `, Trace: ${error.traceId}` : ""})`;
  }
  return connectionErrorMessage(error, copy);
}

export class IntakeApi {
  constructor(
    readonly engineUrl: string,
    readonly apiKey: string,
  ) {}

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(apiUrl(this.engineUrl, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        reason?: string;
        code?: string;
      };
      throw new ApiError(
        response.status,
        payload.code || payload.reason,
        (payload as { trace_id?: string }).trace_id,
        payload.error || payload.message || `Request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }

  categories(): Promise<{ categories: Array<{ category: string }> }> {
    return this.request("/v1/categories");
  }

  defaultCategory(): Promise<{ category: string; can_collect?: boolean }> {
    return this.request("/v1/intake/default-category");
  }

  async checkConnection(): Promise<{ category: string; canCollect?: boolean }> {
    const [_, preference] = await Promise.all([this.categories(), this.defaultCategory()]);
    return {
      category: preference.category,
      ...(preference.can_collect === undefined ? {} : { canCollect: preference.can_collect }),
    };
  }

  collect(input: IntakeSubmission): Promise<IntakeItem> {
    return this.request("/v1/intake/items", { method: "POST", body: JSON.stringify(input) });
  }
}
