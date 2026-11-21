import { describe, expect, test } from "bun:test";
import { dottedPath, findLeafByPath, listConfigLeaves } from "../walk.ts";

describe("listConfigLeaves", () => {
  test("returns a non-empty leaf set", () => {
    const leaves = listConfigLeaves();
    expect(leaves.length).toBeGreaterThan(50);
  });

  test("every leaf has a non-null kind", () => {
    for (const leaf of listConfigLeaves()) {
      expect(leaf.kind).toBeTruthy();
    }
  });

  test("every leaf has a meta.scope of 'global' or 'tenant'", () => {
    for (const leaf of listConfigLeaves()) {
      expect(["global", "tenant"]).toContain(leaf.meta.scope ?? "global");
    }
  });

  test("known secret leaves are flagged sensitive", () => {
    const expectedSecret = [
      "database.url",
      "llm.api_key",
      "llm.providers.anthropic.api_key",
      "auth.session.secret",
      "platform.slack.signing_secret",
      "storage.object_store.access_key_id",
      "observability.langfuse.secret_key",
    ];
    const leaves = listConfigLeaves();
    for (const path of expectedSecret) {
      const leaf = leaves.find((l) => dottedPath(l) === path);
      expect(leaf, `leaf ${path} should exist`).toBeDefined();
      expect(leaf!.meta.secret, `${path} should be secret`).toBe(true);
    }
  });

  test("auth providers are exposed atomically as validated runtime JSON", () => {
    const leaf = findLeafByPath("auth.providers");
    expect(leaf).toBeDefined();
    expect(leaf!.kind).toBe("json");
    expect(leaf!.meta.structural).toBe(true);
    expect(leaf!.meta.runtimeEditable).toBe(true);
    expect(leaf!.meta.secret).toBeUndefined();
    expect(leaf!.meta.requiresRestart).toBeUndefined();
  });

  test("tenant-scoped leaves match the documented set", () => {
    const tenantPaths = new Set(
      listConfigLeaves()
        .filter((l) => l.meta.scope === "tenant")
        .map(dottedPath),
    );
    expect(tenantPaths.has("llm.provider")).toBe(true);
    expect(tenantPaths.has("llm.api_key")).toBe(true);
    expect(tenantPaths.has("queue.concurrency")).toBe(false);
    expect(tenantPaths.has("connectors.mcp.per_server_manifest_byte_cap")).toBe(true);
    expect(tenantPaths.has("server.port")).toBe(false);
  });
});

describe("findLeafByPath", () => {
  test("returns undefined for unknown paths", () => {
    expect(findLeafByPath("does.not.exist")).toBeUndefined();
  });

  test("returns the leaf for an enum path", () => {
    const leaf = findLeafByPath("log.level");
    expect(leaf).toBeDefined();
    expect(leaf!.kind).toBe("enum");
    expect(leaf!.enumValues).toContain("info");
  });

  test("returns the leaf for a nested provider path", () => {
    const leaf = findLeafByPath("llm.providers.anthropic.api_key");
    expect(leaf).toBeDefined();
    expect(leaf!.kind).toBe("string");
    expect(leaf!.meta.secret).toBe(true);
  });
});
