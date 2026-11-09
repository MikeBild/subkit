import { expect, test } from "bun:test";
import { shortIdentifier } from "./identifier.ts";

test("shortIdentifier shortens only a complete UUID, preserving its source case", () => {
  expect(shortIdentifier("123e4567-e89b-12d3-a456-426614174000")).toBe("123e4567…");
  expect(shortIdentifier("123E4567-E89B-12D3-A456-426614174000")).toBe("123E4567…");
});

test("shortIdentifier leaves slugs, boundaries, and malformed UUID shapes intact", () => {
  for (const value of [
    "",
    "workflow-daily-report",
    "x123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-12d3-a456-426614174000x",
    "123e456-e89b-12d3-a456-426614174000",
    "123e45678-e89b-12d3-a456-426614174000",
    "123e4567-e89-12d3-a456-426614174000",
    "123e4567-e89bb-12d3-a456-426614174000",
    "123e4567-e89b-12d-a456-426614174000",
    "123e4567-e89b-12d33-a456-426614174000",
    "123e4567-e89b-12d3-a45-426614174000",
    "123e4567-e89b-12d3-a4566-426614174000",
    "123e4567-e89b-12d3-a456-42661417400",
    "123e4567-e89b-12d3-a456-4266141740000",
    "123e4567_e89b-12d3-a456-426614174000",
    "123e4567-e89b-12d3-a456-42661417400z",
    "123e4567-e89b-12d3-a456",
  ])
    expect(shortIdentifier(value)).toBe(value);
});
