import { describe, expect, test } from "bun:test";
import { classifyAuditProcess } from "../lib/audit-process.ts";

describe("classifyAuditProcess", () => {
  test("keeps the report when bun audit exits one because it found advisories", () => {
    const result = classifyAuditProcess(
      {
        stdout: '{"axios":[{"severity":"high","title":"finding"}]}',
        stderr: "",
        exitCode: 1,
        // Bun 1.3 reports `killed: true` for this ordinary non-zero exit.
        killed: true,
        signalCode: null,
      },
      120_000,
    );

    expect(result).toEqual({
      kind: "report",
      stdout: '{"axios":[{"severity":"high","title":"finding"}]}',
    });
  });

  test("a signal is the timeout evidence", () => {
    expect(
      classifyAuditProcess(
        { stdout: "", stderr: "", exitCode: null, killed: true, signalCode: 15 },
        120_000,
      ),
    ).toEqual({ kind: "unreachable", reason: "no answer within 120s" });
  });

  test("an empty successful response is not a clean report", () => {
    expect(
      classifyAuditProcess(
        {
          stdout: "",
          stderr: "registry unavailable\nretry later",
          exitCode: 0,
          killed: false,
          signalCode: null,
        },
        120_000,
      ),
    ).toEqual({ kind: "unreachable", reason: "no output (registry unavailable)" });
  });
});
