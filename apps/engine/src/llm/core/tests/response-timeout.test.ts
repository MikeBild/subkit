import { describe, expect, test } from "bun:test";
import { describeTurnFailure, timeoutPhaseOf } from "../../../conversations/turn-failure.ts";
import { flush } from "../../../test-helpers/determinism/wait.ts";
import { fetchWithResponseTimeout, type ResponseFetch } from "../response-timeout.ts";

function neverAnswering(seen: { signal: AbortSignal | null }): ResponseFetch {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      seen.signal = init?.signal ?? null;
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
}

describe("fetchWithResponseTimeout — the headers phase the SDK's first-chunk timer cannot see", () => {
  test("a server that accepts the connection but never answers is cut after the budget with the first-chunk wording", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const fetchWithTimeout = fetchWithResponseTimeout(20, neverAnswering(seen));

    let caught: unknown;
    try {
      await fetchWithTimeout("https://provider.example/v1/messages", { method: "POST" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("TimeoutError");
    expect((caught as DOMException).message).toBe("First chunk timeout of 20ms exceeded");
    expect(seen.signal?.aborted).toBe(true);
    expect(timeoutPhaseOf(caught)).toBe("first_chunk");
    expect(describeTurnFailure(caught)).toMatchObject({
      code: "llm_timeout",
      message: "Timed out after 1 s",
      timeout: { phase: "first_chunk", timeout_ms: 20 },
    });
  });

  test("a response inside the budget passes through untouched and the request is never aborted", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const fetchWithTimeout = fetchWithResponseTimeout(1_000, async (_input, init) => {
      seen.signal = init?.signal ?? null;
      return new Response("ok", { status: 200 });
    });

    const response = await fetchWithTimeout("https://provider.example/v1/messages");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    await flush();
    expect(seen.signal?.aborted).toBe(false);
  });

  test("the caller's own abort reaches the request and is reported as that reason, not as a timeout", async () => {
    const seen: { signal: AbortSignal | null } = { signal: null };
    const fetchWithTimeout = fetchWithResponseTimeout(1_000, neverAnswering(seen));
    const caller = new AbortController();
    const pending = fetchWithTimeout("https://provider.example/v1/messages", {
      signal: caller.signal,
    });
    const reason = new Error("turn cancelled");
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.signal?.reason).toBe(reason);
    expect(timeoutPhaseOf(reason)).toBeNull();
  });

  test("a caller signal that is already aborted short-circuits before any request is made", async () => {
    let calls = 0;
    const fetchWithTimeout = fetchWithResponseTimeout(1_000, async () => {
      calls += 1;
      return new Response("ok");
    });
    const caller = new AbortController();
    const reason = new Error("already gone");
    caller.abort(reason);

    await expect(
      fetchWithTimeout("https://provider.example/v1/messages", { signal: caller.signal }),
    ).rejects.toBe(reason);
    expect(calls).toBe(0);
  });
});
