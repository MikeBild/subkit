import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  ApiError,
  apiRequest,
  BOOTSTRAP_TIMEOUT_MS,
  type Bootstrap,
  bootstrap,
  bootstrapLimits,
} from "@/api/client";
import { tenantContextHeaders } from "@/api/tenant-context";
import { render } from "@/components/cockpit/patterns/test-utils";
import { SessionSkeleton, sessionView } from "./session";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function pinnedTenant(): string {
  return tenantContextHeaders()["x-subkit-tenant"] ?? "tenant-a";
}

function hangUntilAborted() {
  return mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );
}

describe("session loading", () => {
  test("the skeleton has the shape of the shell: sidebar, page title and rows", () => {
    const html = render(<SessionSkeleton label="Lädt" />);
    expect(html).toContain('data-testid="session-loading"');
    expect(html).toContain('data-skeleton="sidebar"');
    expect(html).toContain('data-skeleton="content"');
    expect(html).toContain('aria-busy="true"');
  });

  test("the first bootstrap request carries a five second limit", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ csrf_token: "token", tenant: { id: pinnedTenant() } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(bootstrapLimits(undefined)).toEqual({ timeoutMs: BOOTSTRAP_TIMEOUT_MS });
    await bootstrap(bootstrapLimits(undefined));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(BOOTSTRAP_TIMEOUT_MS).toBe(5000);
  });

  test("a refresh of a loaded session is not cut off by the first-load limit", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ csrf_token: "token", tenant: { id: pinnedTenant() } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const loaded = { csrf_token: "token" } as Bootstrap;
    expect(bootstrapLimits(loaded)).toEqual({});
    await bootstrap(bootstrapLimits(loaded));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeUndefined();
  });

  test("a request that outlives its limit fails instead of waiting forever", async () => {
    globalThis.fetch = hangUntilAborted() as unknown as typeof fetch;
    const error = await apiRequest("/v1/cockpit/bootstrap", {}, { timeoutMs: 5 }).catch(
      (reason: unknown) => reason,
    );
    expect((error as DOMException).name).toBe("TimeoutError");
  });

  test("a limited request still ends when its caller cancels it", async () => {
    globalThis.fetch = hangUntilAborted() as unknown as typeof fetch;
    const caller = new AbortController();
    const pending = apiRequest("/v1/slow", { signal: caller.signal }, { timeoutMs: 60_000 }).catch(
      (reason: unknown) => reason,
    );
    caller.abort();
    expect(((await pending) as DOMException).name).toBe("AbortError");
  });

  test("a timed-out first load ends on the bootstrap error page, never in an endless skeleton", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(sessionView({ isPending: false, error: timeout, data: undefined }, false)).toBe(
      "failed",
    );
  });

  test("a refresh that times out or fails keeps the loaded cockpit", () => {
    const data = { csrf_token: "token" } as Bootstrap;
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    expect(sessionView({ isPending: false, error: timeout, data }, false)).toBe("ready");
    expect(
      sessionView({ isPending: false, error: new ApiError(503, null, null), data }, false),
    ).toBe("ready");
  });

  test("loading, a lapsed session and a loaded session each have their own view", () => {
    const data = { csrf_token: "token" } as Bootstrap;
    expect(sessionView({ isPending: true, error: null, data: undefined }, false)).toBe("loading");
    expect(
      sessionView(
        {
          isPending: false,
          error: new ApiError(401, { code: "unauthorized" }, null),
          data: undefined,
        },
        false,
      ),
    ).toBe("signed-out");
    expect(
      sessionView(
        {
          isPending: false,
          error: new ApiError(401, { code: "unauthorized" }, null),
          data,
        },
        false,
      ),
    ).toBe("expired");
    expect(sessionView({ isPending: false, error: null, data }, true)).toBe("expired");
    expect(sessionView({ isPending: false, error: null, data: undefined }, true)).toBe(
      "signed-out",
    );
    expect(sessionView({ isPending: false, error: null, data }, false)).toBe("ready");
  });
});

test("a changed workspace hides cached data even when bootstrap previously succeeded", () => {
  const data = { csrf_token: "old" } as Bootstrap;
  expect(
    sessionView(
      {
        isPending: false,
        error: new ApiError(409, { code: "tenant_context_changed" }, null),
        data,
      },
      false,
    ),
  ).toBe("changed");
  expect(sessionView({ isPending: false, error: null, data }, false, true)).toBe("changed");
});
