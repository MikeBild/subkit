import { describe, expect, test } from "bun:test";
import { ApiError } from "@/api/client";
import {
  createSourceFailureKey,
  saveTextFailureKey,
} from "@/features/knowledge/api/knowledge-source-failure";
import {
  addressPatchBody,
  contentSaveBody,
  createSourceRequest,
} from "@/features/knowledge/api/knowledge-source-request";
import { REFRESH_CRON } from "@/features/knowledge/model/knowledge-sources-model";

describe("source requests", () => {
  const draft = {
    url: " https://docs.example.com ",
    rhythm: "never" as const,
    name: " FAQ ",
    text: "# FAQ",
    file: null,
  };

  test("each add mode sends its own request", () => {
    expect(createSourceRequest({ ...draft, mode: "url" })).toEqual({
      kind: "url",
      body: { url: "https://docs.example.com", refresh_strategy: "manual" },
    });
    expect(createSourceRequest({ ...draft, mode: "text" })).toEqual({
      kind: "text",
      body: { name: "FAQ", content: "# FAQ", mime_type: "text/markdown" },
    });
    const file = new File(["x"], "a.md");
    expect(createSourceRequest({ ...draft, mode: "file", file })).toEqual({ kind: "file", file });
  });

  test("an address change sends only what changed", () => {
    const current = { url: "https://a.example.com", rhythm: "weekly" as const };
    expect(addressPatchBody(current, { url: " https://a.example.com ", rhythm: "weekly" })).toEqual(
      {},
    );
    expect(addressPatchBody(current, { url: "https://b.example.com", rhythm: null })).toEqual({
      source_uri: "https://b.example.com",
    });
    expect(addressPatchBody(current, { url: current.url, rhythm: "daily" })).toEqual({
      refresh_strategy: "scheduled",
      refresh_cron: REFRESH_CRON.daily,
    });
    expect(
      addressPatchBody({ ...current, rhythm: "custom" }, { url: current.url, rhythm: "never" }),
    ).toEqual({ refresh_strategy: "manual", refresh_cron: null });
  });

  test("a text save pins the version and sends a note only when there is one", () => {
    expect(contentSaveBody({ version: "3", path: "a.md", content: "x", note: "  " })).toEqual({
      expected_version: "3",
      path: "a.md",
      content: "x",
    });
    expect(contentSaveBody({ version: "3", path: "a.md", content: "x", note: " why " })).toEqual({
      expected_version: "3",
      path: "a.md",
      content: "x",
      note: "why",
    });
  });

  test("a failed add says whether the file was unreadable or too big", () => {
    expect(createSourceFailureKey(new ApiError(422, null, null))).toBe("kn.sources.unreadable");
    expect(createSourceFailureKey(new ApiError(413, null, null))).toBe("kn.up.tooBig");
    expect(createSourceFailureKey(new ApiError(500, null, null))).toBe("common.actionFailed");
    expect(createSourceFailureKey(new Error("offline"))).toBe("common.actionFailed");
  });

  test("a failed text save names a conflict", () => {
    expect(saveTextFailureKey(new ApiError(409, null, null))).toBe("kn.conflict");
    expect(saveTextFailureKey(new ApiError(422, null, null))).toBe("common.actionFailed");
  });
});
