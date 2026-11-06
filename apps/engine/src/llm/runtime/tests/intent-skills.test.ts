import { describe, expect, it } from "bun:test";
import { detectIntentSkills } from "../context-assembler.ts";

function makeStubExec() {
  const chain: Record<string, () => unknown> = {};
  const noop = () => chain;
  chain.select = noop;
  chain.from = noop;
  chain.where = noop;
  chain.orderBy = () => Promise.resolve([]);
  return chain as unknown as Parameters<typeof detectIntentSkills>[2];
}

describe("detectIntentSkills — keyword extraction (pure, no DB)", () => {
  it("returns an array for any valid input", async () => {
    const result = await detectIntentSkills("tenant-1", {}, makeStubExec());
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns an empty array when the stub DB has no matching skills", async () => {
    const result = await detectIntentSkills(
      "tenant-1",
      { attachmentMimeTypes: ["application/pdf"] },
      makeStubExec(),
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("does not throw when attachmentMimeTypes contains 'application/pdf'", async () => {
    await expect(
      detectIntentSkills("tenant-1", { attachmentMimeTypes: ["application/pdf"] }, makeStubExec()),
    ).resolves.toBeDefined();
  });

  it("does not throw when hasFailedExecution=true", async () => {
    await expect(
      detectIntentSkills("tenant-1", { hasFailedExecution: true }, makeStubExec()),
    ).resolves.toBeDefined();
  });

  it("does not throw when hasMultipleConnectors=true", async () => {
    await expect(
      detectIntentSkills("tenant-1", { hasMultipleConnectors: true }, makeStubExec()),
    ).resolves.toBeDefined();
  });

  it("does not throw with empty opts (triggers 'onboarding' keyword)", async () => {
    await expect(detectIntentSkills("tenant-2", {}, makeStubExec())).resolves.toBeDefined();
  });

  it("does not throw when userMessage contains 'openapi'", async () => {
    await expect(
      detectIntentSkills("tenant-1", { userMessage: "I have an openapi spec" }, makeStubExec()),
    ).resolves.toBeDefined();
  });

  it("does not throw when userMessage contains 'graphql'", async () => {
    await expect(
      detectIntentSkills("tenant-1", { userMessage: "use graphql please" }, makeStubExec()),
    ).resolves.toBeDefined();
  });

  it("does not throw when userMessage contains 'postman'", async () => {
    await expect(
      detectIntentSkills(
        "tenant-1",
        { userMessage: "I have a postman collection" },
        makeStubExec(),
      ),
    ).resolves.toBeDefined();
  });

  it("does not throw for image MIME type", async () => {
    await expect(
      detectIntentSkills("tenant-1", { attachmentMimeTypes: ["image/png"] }, makeStubExec()),
    ).resolves.toBeDefined();
  });

  it("does not throw for an OpenAPI MIME type hint", async () => {
    await expect(
      detectIntentSkills(
        "tenant-1",
        { attachmentMimeTypes: ["application/vnd.oai.openapi+json"] },
        makeStubExec(),
      ),
    ).resolves.toBeDefined();
  });

  it("does not throw for a GraphQL MIME type hint", async () => {
    await expect(
      detectIntentSkills(
        "tenant-1",
        { attachmentMimeTypes: ["application/graphql"] },
        makeStubExec(),
      ),
    ).resolves.toBeDefined();
  });

  it("does not throw for a HAR MIME type hint", async () => {
    await expect(
      detectIntentSkills(
        "tenant-1",
        { attachmentMimeTypes: ["application/har+json"] },
        makeStubExec(),
      ),
    ).resolves.toBeDefined();
  });

  it("does not throw when all options are combined", async () => {
    await expect(
      detectIntentSkills(
        "tenant-1",
        {
          attachmentMimeTypes: ["application/pdf", "image/jpeg"],
          userMessage: "I have an openapi spec and a postman collection",
          hasFailedExecution: true,
          hasMultipleConnectors: true,
        },
        makeStubExec(),
      ),
    ).resolves.toBeDefined();
  });
});
