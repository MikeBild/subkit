import { describe, expect, it } from "bun:test";
import type { components } from "@cli-core/engine-api/openapi";
import {
  connectorCard,
  connectorHealth,
  connectorKind,
  filterCards,
  signInMethod,
  signinFinished,
  signinStrip,
  sortCards,
  testOutcome,
  usageBySlug,
} from "./model";

type Connector = components["schemas"]["Connector"];
const base = {
  id: "c1",
  display_name: "Gmail",
  slug: "gmail",
  environment: "prod",
  health_state: "ok",
  needs_reauth: false,
  auth_type: "oauth2",
  last_tested_at: null,
  updated_at: "u",
  enabled: true,
  category: "communication",
} as unknown as Connector;

describe("sign-in finished signal", () => {
  it("reads the stream payload of a finished sign-in", () => {
    expect(
      signinFinished(
        "connector.oauth.signin_finished",
        JSON.stringify({
          connector_id: "c1",
          attention_id: "connector:c1",
          outcome: "failed",
          reason: "token_exchange_failed",
        }),
      ),
    ).toEqual({ connectorId: "c1", outcome: "failed", reason: "token_exchange_failed" });
    expect(
      signinFinished(
        "connector.oauth.signin_finished",
        JSON.stringify({ connector_id: "c1", outcome: "succeeded" }),
      )?.reason,
    ).toBeNull();
  });
  it("ignores other events and malformed data", () => {
    expect(signinFinished("connector.updated", "{}")).toBeNull();
    expect(signinFinished("connector.oauth.signin_finished", "nope")).toBeNull();
    expect(
      signinFinished("connector.oauth.signin_finished", JSON.stringify({ outcome: "succeeded" })),
    ).toBeNull();
    expect(
      signinFinished(
        "connector.oauth.signin_finished",
        JSON.stringify({ connector_id: "c", outcome: "maybe" }),
      ),
    ).toBeNull();
  });
  it("one strip per outcome", () => {
    expect(signinStrip({ connectorId: "c", outcome: "succeeded", reason: null }).tone).toBe(
      "success",
    );
    expect(signinStrip({ connectorId: "c", outcome: "failed", reason: "x" }).key).toBe(
      "cn.signin.failed",
    );
  });
});

describe("connectors", () => {
  it("health: needs_reauth wins, ok is healthy, everything else degraded", () => {
    expect(connectorHealth({ health_state: "ok", needs_reauth: true })).toBe("reauth");
    expect(connectorHealth({ health_state: "needs_reauth", needs_reauth: false })).toBe("reauth");
    expect(connectorHealth({ health_state: "ok", needs_reauth: false })).toBe("healthy");
    expect(connectorHealth({ health_state: "needs_update", needs_reauth: false })).toBe("degraded");
    expect(connectorHealth({ health_state: "degraded", needs_reauth: false })).toBe("degraded");
  });
  it("sign-in method follows the auth type", () => {
    expect(signInMethod("oauth2")).toBe("account");
    expect(signInMethod("bearer")).toBe("key");
    expect(signInMethod("aws_sigv4")).toBe("secured");
  });
  it("card maps dev to the test environment and falls back to updated_at for the last sync", () => {
    const c = connectorCard({ ...base, environment: "dev" }, 2);
    expect(c).toMatchObject({
      env: "test",
      lastSync: "u",
      usedBy: 2,
      method: "account",
      health: "healthy",
    });
  });
  it("names the driver and counts tools only for an MCP server that reported them", () => {
    expect(connectorCard({ ...base, driver: "http", tools_count: 4 }, 0)).toMatchObject({
      driver: "http",
      tools: null,
    });
    expect(connectorCard({ ...base, driver: "mcp", tools_count: 12 }, 0)).toMatchObject({
      driver: "mcp",
      tools: 12,
    });
    expect(connectorCard({ ...base, driver: "mcp", tools_count: null }, 0).tools).toBeNull();
  });
  it("counts each workflow once per connector", () => {
    const m = usageBySlug([{ connectors: ["gmail", "gmail", "drive"] }, { connectors: ["gmail"] }]);
    expect(m.get("gmail")).toBe(2);
    expect(m.get("drive")).toBe(1);
  });
  it("sorts reauth before degraded before healthy, then by name", () => {
    const cards = [
      connectorCard({ ...base, display_name: "B" }, 0),
      connectorCard({ ...base, display_name: "A", needs_reauth: true }, 0),
      connectorCard({ ...base, display_name: "C", health_state: "degraded" }, 0),
    ];
    expect(sortCards(cards).map((c) => c.name)).toEqual(["A", "C", "B"]);
  });
  it("test outcome: failed, slow on warnings or degraded, ok otherwise", () => {
    expect(testOutcome({ ok: false }, "healthy")).toBe("failed");
    expect(testOutcome({ ok: true, warning_only: true }, "healthy")).toBe("slow");
    expect(testOutcome({ ok: true }, "degraded")).toBe("slow");
    expect(testOutcome({ ok: true }, "healthy")).toBe("ok");
  });
  it("kind follows the driver first, then the sign-in; unauthenticated has none", () => {
    expect(connectorKind({ driver: "mcp", auth_type: "oauth2" })).toBe("mcp");
    expect(connectorKind({ driver: "http", auth_type: "oauth2_client" })).toBe("oauth");
    expect(connectorKind({ driver: "http", auth_type: "bearer" })).toBe("key");
    expect(connectorKind({ driver: "http", auth_type: "none" })).toBeNull();
  });
  it("filters by kind, category and who wrote the description", () => {
    const cards = [
      connectorCard(
        { ...base, driver: "mcp", category: "dev", description_source: "llm" } as Connector,
        0,
      ),
      connectorCard(
        {
          ...base,
          display_name: "Stripe",
          driver: "http",
          auth_type: "bearer",
          category: "billing",
          description_source: "human",
        } as Connector,
        0,
      ),
    ];
    const names = (f: Parameters<typeof filterCards>[1]) =>
      filterCards(cards, f).map((c) => c.name);
    expect(names({ q: "", attention: false, kind: "mcp" })).toEqual(["Gmail"]);
    expect(names({ q: "", attention: false, category: "billing" })).toEqual(["Stripe"]);
    expect(names({ q: "", attention: false, createdBy: "ai" })).toEqual(["Gmail"]);
    expect(names({ q: "", attention: false, createdBy: "person" })).toEqual(["Stripe"]);
    expect(names({ q: "bill", attention: false })).toEqual(["Stripe"]);
  });
});
