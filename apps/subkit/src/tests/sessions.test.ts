import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSessionMetadata,
  loadSessionMetadata,
  mostRecentSession,
  saveSessionMetadata,
  sessionPath,
  sessionsDir,
} from "../sessions.ts";

let tmpHome: string;
let origSkHome: string | undefined;

describe("subkit sessions store", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "subkit-sessions-home-"));
    origSkHome = process.env.SUBKIT_HOME;
    process.env.SUBKIT_HOME = tmpHome;
  });
  afterEach(() => {
    if (origSkHome !== undefined) process.env.SUBKIT_HOME = origSkHome;
    else delete process.env.SUBKIT_HOME;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("saveSessionMetadata + loadSessionMetadata round-trips", () => {
    const id = "c1-12345678-1111-1111-1111-111111111111";
    saveSessionMetadata({
      conversation_id: id,
      engine_url: "http://localhost:8080",
      tenant_id: "t-1",
      title: "first session",
      model: "anthropic:claude-sonnet-4-6",
      created_at: "2026-04-15T12:00:00.000Z",
      last_used_at: "2026-04-15T12:05:00.000Z",
    });
    const loaded = loadSessionMetadata(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.conversation_id).toBe(id);
    expect(loaded?.title).toBe("first session");
    expect(sessionPath(id)).toContain(`sessions/${id}.json`);
    expect(sessionsDir()).toContain("sessions");
  });

  test("listSessionMetadata orders by last_used_at newest first", () => {
    saveSessionMetadata({
      conversation_id: "c-old",
      engine_url: "http://e1",
      tenant_id: "t",
      title: "old",
      model: null,
      created_at: "2026-04-01T00:00:00.000Z",
      last_used_at: "2026-04-01T00:00:00.000Z",
    });
    saveSessionMetadata({
      conversation_id: "c-new",
      engine_url: "http://e1",
      tenant_id: "t",
      title: "new",
      model: null,
      created_at: "2026-04-10T00:00:00.000Z",
      last_used_at: "2026-04-10T00:00:00.000Z",
    });
    const all = listSessionMetadata();
    expect(all.map((s) => s.conversation_id)).toEqual(["c-new", "c-old"]);
  });

  test("listSessionMetadata filters by engine + tenant", () => {
    saveSessionMetadata({
      conversation_id: "c-prod",
      engine_url: "https://prod",
      tenant_id: "prod-tenant",
      title: null,
      model: null,
      created_at: "2026-04-10T00:00:00.000Z",
      last_used_at: "2026-04-10T00:00:00.000Z",
    });
    saveSessionMetadata({
      conversation_id: "c-dev",
      engine_url: "http://localhost:8080",
      tenant_id: "dev-tenant",
      title: null,
      model: null,
      created_at: "2026-04-11T00:00:00.000Z",
      last_used_at: "2026-04-11T00:00:00.000Z",
    });
    const dev = listSessionMetadata({
      engine_url: "http://localhost:8080",
      tenant_id: "dev-tenant",
    });
    expect(dev.length).toBe(1);
    expect(dev[0]?.conversation_id).toBe("c-dev");
  });

  test("mostRecentSession returns the newest cached entry for the filter", () => {
    saveSessionMetadata({
      conversation_id: "c-1",
      engine_url: "http://e",
      tenant_id: "t",
      title: null,
      model: null,
      created_at: "2026-04-01T00:00:00.000Z",
      last_used_at: "2026-04-01T00:00:00.000Z",
    });
    saveSessionMetadata({
      conversation_id: "c-2",
      engine_url: "http://e",
      tenant_id: "t",
      title: null,
      model: null,
      created_at: "2026-04-02T00:00:00.000Z",
      last_used_at: "2026-04-02T00:00:00.000Z",
    });
    const latest = mostRecentSession({ engine_url: "http://e", tenant_id: "t" });
    expect(latest?.conversation_id).toBe("c-2");
    expect(mostRecentSession({ engine_url: "http://other", tenant_id: "t" })).toBeNull();
  });
});
