import { apiUrl } from "./clipper.ts";
import type { IntakeItem, IntakeSubmission } from "./types.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
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
        payload.error || payload.message || `Request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }

  categories(): Promise<{ categories: Array<{ category: string }> }> {
    return this.request("/v1/categories");
  }

  defaultCategory(): Promise<{ category: string }> {
    return this.request("/v1/intake/default-category");
  }

  collect(input: IntakeSubmission): Promise<IntakeItem> {
    return this.request("/v1/intake/items", { method: "POST", body: JSON.stringify(input) });
  }
}
