import { describe, expect, test } from "bun:test";
import { isGenericName } from "./create-knowledge-source.ts";

describe("isGenericName", () => {
  test('"Uploaded Knowledge Source" → true (canonical placeholder)', () => {
    expect(isGenericName("Uploaded Knowledge Source")).toBe(true);
  });

  test('"uploaded knowledge source" → true (case-insensitive)', () => {
    expect(isGenericName("uploaded knowledge source")).toBe(true);
  });

  test('"Uploaded  Knowledge  Source" → true (extra whitespace tolerated)', () => {
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

  test('"  Uploaded Knowledge Source  " → true (leading/trailing whitespace stripped)', () => {
    expect(isGenericName("  Uploaded Knowledge Source  ")).toBe(true);
  });

  test('"Uploaded API reference for vendor X" → false (legitimate name starting with "Uploaded")', () => {
    expect(isGenericName("Uploaded API reference for vendor X")).toBe(false);
  });

  test('"OCPP-2.0.1" → false (domain-specific name)', () => {
    expect(isGenericName("OCPP-2.0.1")).toBe(false);
  });

  test('"Internal API Docs" → false (legitimate descriptive name)', () => {
    expect(isGenericName("Internal API Docs")).toBe(false);
  });

  test('"" → false (empty string does not match)', () => {
    expect(isGenericName("")).toBe(false);
  });

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
    expect(isGenericName("Uploaded content from chat session 2025-10")).toBe(false);
  });
});
