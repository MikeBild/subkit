import { describe, expect, test } from "bun:test";
import { noticeResponse } from "@/api/transport";
import { render } from "@/components/cockpit/patterns/test-utils";
import { SseHttpError } from "@/lib/sse-stream";
import { connectivity, createConnectivity } from "./connectivity";
import { DesktopStatusView } from "./desktop-status";
import { parseDesktopStatus } from "./desktop-status-model";
import { streamRefusal } from "./live-events";
import { LiveIndicator } from "./live-indicator";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

const DESKTOP_OFFLINE = parseDesktopStatus({
  banner: {
    kind: "offline",
    tone: "warning",
    title: "Server offline",
    body: "SubKit versucht automatisch, die Verbindung wiederherzustellen.",
  },
});

function screen(store: ReturnType<typeof createConnectivity>) {
  const connection = store.get();
  return {
    banner: render(
      <DesktopStatusView status={DESKTOP_OFFLINE} connection={connection} bridge={null} />,
    ),
    badge: render(<LiveIndicator status={connection.status} />),
  };
}

describe("connected or offline: one source of truth", () => {
  test("offline, then a successful request: the banner is gone and the badge says connected", () => {
    const store = createConnectivity(() => new Date("2026-11-23T07:17:00.000Z"));
    store.stream("live", "stream_hello");
    store.stream("reconnecting", "stream_refused", TRACE);

    const lost = screen(store);
    expect(lost.banner).toContain('data-testid="desktop-status-offline"');
    expect(lost.badge).toContain('data-live-status="reconnecting"');
    expect(lost.badge).not.toContain("Verbunden");

    store.reachable();

    const back = screen(store);
    expect(back.banner).toBe("");
    expect(back.badge).toContain('data-live-status="live"');
    expect(back.badge).toContain("Verbunden");
    expect(store.get().stream).toBe("reconnecting");
  });

  test("the banner never shows next to a green badge, whatever the desktop app reports", () => {
    const store = createConnectivity();
    store.stream("live", "stream_hello");
    const { banner, badge } = screen(store);
    expect(badge).toContain("Verbunden");
    expect(banner).toBe("");
  });

  test("the log records going offline and the recovery with their cause", () => {
    const store = createConnectivity(() => new Date("2026-11-23T07:17:00.000Z"));
    store.stream("live", "stream_hello");
    store.stream("reconnecting", "stream_refused", TRACE);
    store.reachable();
    expect(store.log()).toEqual([
      {
        code: `connection.offline status=reconnecting cause=stream_refused trace=${TRACE}`,
        at: "2026-11-23T07:17:00.000Z",
      },
      { code: "connection.recovered status=live cause=request_ok", at: "2026-11-23T07:17:00.000Z" },
    ]);
  });

  test("the first connect is no recovery", () => {
    const store = createConnectivity();
    store.stream("live", "stream_hello");
    expect(store.log()).toEqual([]);
  });

  test("any answer below 500 proves the server is reachable, a 5xx keeps its trace id", () => {
    connectivity.stream("reconnecting", "stream_ended");
    noticeResponse(503, TRACE);
    expect(connectivity.get()).toMatchObject({ status: "reconnecting", traceId: TRACE });
    noticeResponse(200, null);
    expect(connectivity.get()).toMatchObject({
      status: "live",
      cause: "request_ok",
      traceId: null,
    });
  });

  test("a refused stream reloads the session or workspace instead of reporting the server offline", () => {
    expect(streamRefusal(new SseHttpError(409, "tenant_context_changed"))).toBe(
      "tenant_context_changed",
    );
    expect(streamRefusal(new SseHttpError(401, "unauthorized"))).toBe("session_expired");
    expect(streamRefusal(new SseHttpError(409, "conflict"))).toBeNull();
    expect(streamRefusal(new SseHttpError(503, null))).toBeNull();
  });
});
