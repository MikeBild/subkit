// Unit tests for the isGenericName guard introduced in 6.2.12.
//
// The guard fires when the LLM invents a generic placeholder name like
// "Uploaded Knowledge Source" in a `create_knowledge_source` tool call.
// The engine then derives the KS name from the uploaded file's filename
// instead, preventing the slug / title / audit-metadata pollution
// surfaced in the OCPP-2.0.1.md session repro.

import { describe, expect, test } from "bun:test";

import { isGenericName } from "./create-knowledge-source.ts";

describe("isGenericName", () => {
  // --- Positive cases (should be caught as generic) ---

  test('"Uploaded Knowledge Source" → true (canonical placeholder)', () => {
    expect(isGenericName("Uploaded Knowledge Source")).toBe(true);
  });

  test('"uploaded knowledge source" → true (case-insensitive)', () => {
    expect(isGenericName("uploaded knowledge source")).toBe(true);
  });

  test('"Uploaded  Knowledge  Source" → true (extra whitespace tolerated)', () => {
    // The regex uses \s+ between each word so double-spaces still match.
    expect(isGenericName("Uploaded  Knowledge  Source")).toBe(true);
  });

  test('"Attachment" → true', () => {
    expect(isGenericName("Attachment")).toBe(true);
  });

  test('"attachment" → true (case-insensitive)', () => {
    expect(isGenericName("attachment")).toBe(true);
  });

  test('"File" → true', () => {
    expect(isGenericName("File")).toBe(true);
  });

  test('"file" → true (case-insensitive)', () => {
    expect(isGenericName("file")).toBe(true);
  });

  test('"Document" → true', () => {
    expect(isGenericName("Document")).toBe(true);
  });

  test('"document" → true (case-insensitive)', () => {
    expect(isGenericName("document")).toBe(true);
  });

  test('"Untitled" → true', () => {
    expect(isGenericName("Untitled")).toBe(true);
  });

  test('"UNTITLED" → true (case-insensitive)', () => {
    expect(isGenericName("UNTITLED")).toBe(true);
  });

  // Leading/trailing whitespace should not defeat the guard (name.trim()).
  test('"  Uploaded Knowledge Source  " → true (leading/trailing whitespace stripped)', () => {
    expect(isGenericName("  Uploaded Knowledge Source  ")).toBe(true);
  });

  // --- Negative cases (legitimate names that start with the same word) ---

  test('"Uploaded API reference for vendor X" → false (legitimate name starting with "Uploaded")', () => {
    // The whole-string anchoring on the GENERIC_NAME_PATTERNS regexes
    // must not match a sentence that merely starts with "Uploaded" but
    // continues with meaningful content.
    expect(isGenericName("Uploaded API reference for vendor X")).toBe(false);
  });

  test('"OCPP-2.0.1" → false (domain-specific name)', () => {
    expect(isGenericName("OCPP-2.0.1")).toBe(false);
  });

  test('"Internal API Docs" → false (legitimate descriptive name)', () => {
    expect(isGenericName("Internal API Docs")).toBe(false);
  });

  test('"" → false (empty string does not match)', () => {
    // An empty name cannot be a generic placeholder match — the patterns
    // require at least one non-whitespace token.
    expect(isGenericName("")).toBe(false);
  });

  // --- Code-review extensions: variants the LLM might invent next ---

  test('"Knowledge Source" → true (no "Uploaded" prefix)', () => {
    expect(isGenericName("Knowledge Source")).toBe(true);
  });

  test('"New Knowledge Source" → true', () => {
    expect(isGenericName("New Knowledge Source")).toBe(true);
  });

  test('"New File" / "New Document" → true', () => {
    expect(isGenericName("New File")).toBe(true);
    expect(isGenericName("New Document")).toBe(true);
  });

  test('"Pasted Content" / "Pasted text" / "Pasted Document" → true', () => {
    expect(isGenericName("Pasted Content")).toBe(true);
    expect(isGenericName("Pasted text")).toBe(true);
    expect(isGenericName("Pasted Document")).toBe(true);
  });

  test('"Untitled-1" / "Untitled 7" / "Untitled_3" → true', () => {
    expect(isGenericName("Untitled-1")).toBe(true);
    expect(isGenericName("Untitled 7")).toBe(true);
    expect(isGenericName("Untitled_3")).toBe(true);
  });

  test('"Content" / "content" → true (single-word generic)', () => {
    expect(isGenericName("Content")).toBe(true);
    expect(isGenericName("content")).toBe(true);
  });

  test('"Uploaded content from chat" → false (qualified, not a bare generic)', () => {
    // Pre-fix the LLM said "Uploaded Knowledge Source"; we still want
    // legitimate qualifications like "Uploaded content from chat
    // session 2025-10" to land as names.
    expect(isGenericName("Uploaded content from chat session 2025-10")).toBe(false);
  });
});
