import { expect, test } from "bun:test";
import { ApiError, CollectionInputError, collectionErrorMessage, IntakeApi } from "./api.ts";
import { createDraft } from "./clipper.ts";
import { intakeSubmission } from "./intake.ts";
import { copy, offersHelp } from "./ui.ts";

test("category lookup retains its error code", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  Object.assign(globalThis, {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return Response.json(
        { code: "request_conflict", message: "already exists" },
        { status: 409 },
      );
    },
  });
  try {
    await expect(
      new IntakeApi("https://engine.example/prefix", "key").categories(),
    ).rejects.toMatchObject({
      status: 409,
      code: "request_conflict",
    });
    expect(request?.url).toBe("https://engine.example/prefix/v1/categories");
  } finally {
    Object.assign(globalThis, { fetch: originalFetch });
  }
});

test("category payload keeps original capture separate from title edits and notes", () => {
  const draft = createDraft(
    {
      title: "Original",
      sourceUrl: "https://example.test/page",
      capturedAt: "2020-01-01T00:00:00Z",
      author: "Source author",
    },
    "Original text",
    "https://engine.example",
  );
  draft.metadata = {
    ...draft.metadata,
    title: "My title",
    sourceUrl: "https://example.test/edited",
  };
  draft.body = "Edited extract";
  draft.note = "Useful idea";
  draft.category = "research";
  const submitted = intakeSubmission(draft, "request");
  expect(submitted.title).toBe("My title");
  expect(submitted.body).toBe("Edited extract");
  expect(submitted.note).toBe("Useful idea");
  expect(submitted.source_url).toBe("https://example.test/page");
  expect(submitted.original_snapshot).toMatchObject({
    title: "Original",
    body: "Original text",
    source_author: "Source author",
    origin: "capture",
  });
  expect(submitted.category).toBe("research");
});

test("restored drafts never claim to be a verified original page capture", () => {
  const draft = createDraft(
    {
      title: "Edited before update",
      sourceUrl: "https://example.test",
      capturedAt: "2020-01-01T00:00:00Z",
    },
    "Edited draft",
    "https://engine.example",
  );
  delete draft.originalCapture;
  expect(intakeSubmission(draft, "request").original_snapshot.origin).toBe("restored_draft");
});

test("local collection validation shows its own message instead of a connection failure", () => {
  const text = copy.en;
  const message = collectionErrorMessage(new CollectionInputError(text.categoryRequired), text);
  expect(message).toBe("Enter a valid category.");
  expect(message).not.toBe(text.connectionFailed);
  expect(offersHelp(text, message)).toBe(false);
});

test("collection failures keep their api and network mappings", () => {
  const text = copy.en;
  const apiFailure = (status: number) => new ApiError(status, undefined, "trace-1", "failed");
  expect(collectionErrorMessage(apiFailure(401), text)).toBe(text.invalidApiKey);
  expect(collectionErrorMessage(apiFailure(403), text)).toBe(text.missingIntakeWritePermission);
  expect(collectionErrorMessage(apiFailure(409), text)).toBe(text.duplicate);
  expect(collectionErrorMessage(apiFailure(422), text)).toBe(text.collectionRejected);
  expect(collectionErrorMessage(apiFailure(500), text)).toBe(
    `${text.apiResponseFailed} (HTTP 500, Trace: trace-1)`,
  );
  expect(collectionErrorMessage(new TypeError("Failed to fetch"), text)).toBe(
    text.connectionFailed,
  );
});
