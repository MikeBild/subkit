import { describe, expect, test } from "bun:test";
import { EngineError, engineErrorDetailLines, reportCommandError } from "./errors.ts";

const body = {
  code: "bad_request",
  message: "request validation failed",
  details: { formErrors: [], fieldErrors: { name: ["Required"], driver: ["Required"] } },
};

function capture(stream: "stdout" | "stderr", fn: () => void): string {
  const target = process[stream];
  const original = target.write.bind(target);
  let out = "";
  target.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof target.write;
  try {
    fn();
  } catch {
  } finally {
    target.write = original;
  }
  return out;
}

describe("engine error details", () => {
  test("field errors become one line per field", () => {
    expect(
      engineErrorDetailLines({ formErrors: ["bad body"], fieldErrors: { name: ["Required"] } }),
    ).toEqual(["bad body", "name: Required"]);
  });

  test("issue lists are rendered with their path", () => {
    expect(
      engineErrorDetailLines({ issues: [{ path: ["config", "oauth"], message: "Invalid" }] }),
    ).toEqual(["config.oauth: Invalid"]);
  });

  test("text output names the failing fields", () => {
    const err = new EngineError(400, body);
    const out = capture("stderr", () => reportCommandError(err));
    expect(out).toContain("name: Required");
    expect(out).toContain("driver: Required");
  });

  test("json output carries the details", () => {
    const err = new EngineError(400, body);
    const out = capture("stdout", () => reportCommandError(err, { json: true }));
    const parsed = JSON.parse(out) as { details?: { fieldErrors?: Record<string, string[]> } };
    expect(parsed.details?.fieldErrors?.name).toEqual(["Required"]);
  });
});
