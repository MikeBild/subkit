import { beforeEach, describe, expect, test } from "bun:test";
import { noticeResponse } from "@/api/transport";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import { SseHttpError } from "@/lib/sse-stream";
import { connectivity, createConnectivity, useConnectivity } from "./connectivity";
import { DesktopStatusView } from "./desktop-status";
import { parseDesktopStatus } from "./desktop-status-model";
import { streamRefusal, useLiveStatus } from "./live-events";
import { LIVE_LABEL, LiveIndicator } from "./live-indicator";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

const DESKTOP_OFFLINE = parseDesktopStatus({
  banner: {
    kind: "offline",
    tone: "warning",
    title: "Server offline",
    body: "SubKit versucht automatisch, die Verbindung wiederherzustellen.",
  },
});

function Screen() {
  const connection = useConnectivity();
  const { status } = useLiveStatus();
  return (
    <>
      <DesktopStatusView status={DESKTOP_OFFLINE} connection={connection} bridge={null} />
      <LiveIndicator status={status} />
    </>
  );
}

const CONNECTED = translate("de", LIVE_LABEL.live);

describe("connected or offline: one source of truth", () => {
  beforeEach(() => connectivity.stream("connecting", "starting"));

  test("offline, then a successful request: the banner is gone and the badge says connected", () => {
    connectivity.stream("live", "stream_hello");
    connectivity.stream("reconnecting", "stream_refused", TRACE);

    const lost = render(<Screen />);
    expect(lost).toContain('data-testid="desktop-status-offline"');
    expect(lost).toContain('data-live-status="reconnecting"');
    expect(lost).not.toContain(CONNECTED);

    noticeResponse(200, null);

    const back = render(<Screen />);
    expect(back).not.toContain('data-testid="desktop-status');
    expect(back).toContain('data-live-status="live"');
    expect(back).toContain(CONNECTED);
    expect(connectivity.get().stream).toBe("reconnecting");
  });

  test("the banner never shows next to a green badge, whatever the desktop app reports", () => {
    connectivity.stream("live", "stream_hello");
    const html = render(<Screen />);
    expect(html).toContain(CONNECTED);
    expect(html).not.toContain('data-testid="desktop-status');
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
