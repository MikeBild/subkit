import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertLiveInputBound,
  assertLiveToolEvidence,
  DEFAULT_KEY_FILE,
  DEFAULT_TIMEOUT_MS,
  exitCodeFor,
  LIVE_CHECK_NAMES,
  LIVE_INPUT_BYTE_LIMIT,
  LIVE_OUTPUT_TOKEN_LIMITS,
  LIVE_TOOL_EXAMPLE,
  type LiveCheckResult,
  liveGateFailureHint,
  orderedForFlow,
  parseLiveArgs,
  parseModelRef,
  readKeyFile,
  redactDetail,
  renderTable,
} from "../llm-live-checks.ts";

const PRIMARY = "claude-sonnet-4-6";
const FALLBACK = "claude-opus-4-7";

describe("live tool evidence", () => {
  const call = { toolName: "record_check", input: { name: "live-gate", ok: true } };
  const description = `Records a check.\n\nInput Examples:\n${JSON.stringify(LIVE_TOOL_EXAMPLE)}`;
  const anthropic = { tools: [{ name: "record_check", input_examples: [LIVE_TOOL_EXAMPLE] }] };
  const openai = { tools: [{ type: "function", name: "record_check", description }] };

  test("accepts Anthropic native examples and OpenAI Responses and Chat tool descriptions", () => {
    assertLiveToolEvidence("anthropic", JSON.stringify(anthropic), [call]);
    assertLiveToolEvidence("openai", openai, [call]);
    assertLiveToolEvidence(
      "openai",
      {
        tools: [{ type: "function", function: { name: "record_check", description } }],
      },
      [call],
    );
  });

  test("prompt text and unrelated tool examples cannot prove examples on the target tool", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      for (const tools of [
        [],
        [{ type: "function", name: "record_check", description: "Records a check." }],
        [{ type: "function", name: "other", description, input_examples: [LIVE_TOOL_EXAMPLE] }],
      ]) {
        expect(() =>
          assertLiveToolEvidence(
            provider,
            {
              messages: [{ role: "user", content: `live-gate input_examples ${description}` }],
              tools,
            },
            [call],
          ),
        ).toThrow("verified input example");
      }
    }
  });

  test("rejects mismatched native or description examples and malformed bodies", () => {
    expect(() =>
      assertLiveToolEvidence(
        "anthropic",
        {
          tools: [{ name: "record_check", input_examples: [{ ...LIVE_TOOL_EXAMPLE, ok: false }] }],
        },
        [call],
      ),
    ).toThrow();
    expect(() =>
      assertLiveToolEvidence(
        "openai",
        {
          tools: [
            { type: "function", name: "record_check", description: "Input Examples:\ninvalid" },
          ],
        },
        [call],
      ),
    ).toThrow();
    for (const body of [null, "invalid", {}, { tools: null }]) {
      expect(() => assertLiveToolEvidence("openai", body, [call])).toThrow();
    }
  });

  test("requires exactly the requested tool invocation and validated input", () => {
    for (const calls of [
      [],
      [call, call],
      [{ ...call, toolName: "other" }],
      [{ ...call, input: LIVE_TOOL_EXAMPLE }],
      [{ ...call, input: { name: "live-gate", ok: false } }],
      [{ ...call, input: { ...call.input, extra: true } }],
      [{ ...call, input: null }],
    ]) {
      expect(() => assertLiveToolEvidence("anthropic", anthropic, calls)).toThrow(
        "required record_check",
      );
      expect(() => assertLiveToolEvidence("openai", openai, calls)).toThrow(
        "required record_check",
      );
    }
  });
});

describe("live request bounds", () => {
  test("accepts the byte boundary and rejects larger input before dispatch", () => {
    expect(assertLiveInputBound("x".repeat(LIVE_INPUT_BYTE_LIMIT - 2))).toBe(LIVE_INPUT_BYTE_LIMIT);
    expect(() => assertLiveInputBound("x".repeat(LIVE_INPUT_BYTE_LIMIT - 1))).toThrow(
      "live gate input exceeds",
    );
    expect(() => assertLiveInputBound("🔥".repeat(LIVE_INPUT_BYTE_LIMIT / 4))).toThrow(
      "live gate input exceeds",
    );
  });

  test("caps both structured checks and the tool check", () => {
    expect(LIVE_OUTPUT_TOKEN_LIMITS).toEqual({
      generate_workflow: 1024,
      judge_verdict: 512,
      tool_input_examples: 512,
    });
  });
});

function result(partial: Partial<LiveCheckResult>): LiveCheckResult {
  return {
    model: PRIMARY,
    check: "generate_workflow",
    status: "PASS",
    ms: 1234,
    detail: "ok",
    ...partial,
  };
}

describe("llm-live-checks · parseLiveArgs", () => {
  test("defaults to claude-key.txt, both release models and a 60 s timeout", () => {
    const args = parseLiveArgs([]);
    expect(args.keyFile).toBe(DEFAULT_KEY_FILE);
    expect(args.keyFile).toBe("claude-key.txt");
    expect(args.models).toEqual([PRIMARY, FALLBACK]);
    expect(args.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(args.timeoutMs).toBe(60_000);
  });

  test("reads --key-file, --models and --timeout-ms", () => {
    const args = parseLiveArgs([
      "--key-file",
      "/tmp/other.txt",
      "--models",
      " a , b,,c ",
      "--timeout-ms",
      "1500",
    ]);
    expect(args).toEqual({
      keyFile: "/tmp/other.txt",
      openaiKeyFile: "openai-key.txt",
      models: ["a", "b", "c"],
      timeoutMs: 1500,
    });
  });

  test("rejects a missing value, an empty model list, a bad timeout and an unknown flag", () => {
    expect(() => parseLiveArgs(["--key-file"])).toThrow("--key-file needs a path");
    expect(() => parseLiveArgs(["--models", " , "])).toThrow("at least one model id");
    expect(() => parseLiveArgs(["--timeout-ms", "soon"])).toThrow("positive integer");
    expect(() => parseLiveArgs(["--timeout-ms", "0"])).toThrow("positive integer");
    expect(() => parseLiveArgs(["--bypass"])).toThrow("unknown argument: --bypass");
  });
});

describe("llm-live-checks · readKeyFile", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sk-llm-live-checks-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns the trimmed file content", () => {
    const path = join(dir, "present.txt");
    writeFileSync(path, "  fake-key-value\n\n");
    expect(readKeyFile(path)).toBe("fake-key-value");
  });

  test("returns null for a missing file", () => {
    expect(readKeyFile(join(dir, "missing.txt"))).toBeNull();
  });

  test("returns null for an empty or whitespace-only file", () => {
    const path = join(dir, "empty.txt");
    writeFileSync(path, " \n\t\n");
    expect(readKeyFile(path)).toBeNull();
  });
});

describe("llm-live-checks · orderedForFlow", () => {
  test("generate and judge hit the fallback model first", () => {
    expect(orderedForFlow([PRIMARY, FALLBACK], "generate")).toEqual([FALLBACK, PRIMARY]);
    expect(orderedForFlow([PRIMARY, FALLBACK], "judge")).toEqual([FALLBACK, PRIMARY]);
  });

  test("non-elevated flows keep the configured order", () => {
    expect(orderedForFlow([PRIMARY, FALLBACK], "converse")).toEqual([PRIMARY, FALLBACK]);
    expect(orderedForFlow([PRIMARY, FALLBACK], "repair")).toEqual([PRIMARY, FALLBACK]);
  });

  test("a single model, identical models and extra models are left alone", () => {
    expect(orderedForFlow([PRIMARY], "generate")).toEqual([PRIMARY]);
    expect(orderedForFlow([PRIMARY, PRIMARY], "generate")).toEqual([PRIMARY, PRIMARY]);
    expect(orderedForFlow([PRIMARY, FALLBACK, "third"], "generate")).toEqual([
      FALLBACK,
      PRIMARY,
      "third",
    ]);
    expect(orderedForFlow([], "generate")).toEqual([]);
  });

  test("does not mutate its input", () => {
    const models = [PRIMARY, FALLBACK];
    orderedForFlow(models, "generate");
    expect(models).toEqual([PRIMARY, FALLBACK]);
  });
});

describe("llm-live-checks · renderTable", () => {
  test("renders a header and one aligned row per result", () => {
    const table = renderTable([
      result({ check: "generate_workflow", ms: 812, detail: "steps=2" }),
      result({ model: FALLBACK, check: "tool_input_examples", status: "FAIL", ms: 9, detail: "x" }),
    ]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^MODEL\s+CHECK\s+STATUS\s+MS\s+DETAIL$/);
    expect(lines[1]).toMatch(
      new RegExp(`^${PRIMARY}\\s+generate_workflow\\s+PASS\\s+812\\s+steps=2$`),
    );
    expect(lines[2]).toMatch(new RegExp(`^${FALLBACK}\\s+tool_input_examples\\s+FAIL\\s+9\\s+x$`));
    const statusColumn = lines.map((l) =>
      l.indexOf("PASS") === -1 ? l.indexOf("FAIL") : l.indexOf("PASS"),
    );
    expect(statusColumn[1]).toBe(statusColumn[2]);
  });

  test("renders only the header for no results", () => {
    expect(renderTable([]).split("\n")).toHaveLength(1);
  });
});

describe("llm-live-checks · exitCodeFor", () => {
  test("a missing key is 2 regardless of results", () => {
    expect(exitCodeFor([], false)).toBe(2);
    expect(exitCodeFor([result({})], false)).toBe(2);
  });

  test("any FAIL is 1", () => {
    expect(exitCodeFor([result({}), result({ status: "FAIL" })], true)).toBe(1);
  });

  test("no results with a key present is 1 (nothing was verified)", () => {
    expect(exitCodeFor([], true)).toBe(1);
  });

  test("all PASS is 0", () => {
    expect(exitCodeFor([result({}), result({ check: "judge_verdict" })], true)).toBe(0);
  });
});

describe("llm-live-checks · liveGateFailureHint", () => {
  test("names the tag, the key file, both overrides and the absence of a bypass", () => {
    const hint = liveGateFailureHint("v9.7.0");
    expect(hint).toContain("v9.7.0");
    expect(hint).toContain("./claude-key.txt");
    expect(hint).toContain("--key-file");
    expect(hint).toContain("--models");
    expect(hint).toContain("verify:llm-live");
    expect(hint).toContain("no bypass");
  });
});

describe("llm-live-checks · redactDetail", () => {
  test("masks Anthropic and SubKit key shapes and the given secrets", () => {
    const masked = redactDetail(
      "401 for sk-ant-api03-AbC_123 and wf_live_XYZ-9 with literal SECRETVALUE",
      ["SECRETVALUE"],
    );
    expect(masked).toBe("401 for sk-ant-*** and wf_live_*** with literal ***");
  });

  test("collapses whitespace and truncates long details", () => {
    const masked = redactDetail(`line one\n\n   line two ${"z".repeat(400)}`);
    expect(masked.startsWith("line one line two ")).toBe(true);
    expect(masked.length).toBe(200);
    expect(masked.endsWith("…")).toBe(true);
  });
});

describe("llm-live-checks · module contract", () => {
  test("lists the three live checks", () => {
    expect([...LIVE_CHECK_NAMES]).toEqual([
      "generate_workflow",
      "judge_verdict",
      "tool_input_examples",
    ]);
  });

  test("the pure module imports neither `ai` nor any @ai-sdk package directly", () => {
    const source = readFileSync(new URL("../llm-live-checks.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']ai["']/);
    expect(source).not.toMatch(/from\s+["']@ai-sdk\//);
    expect(source).not.toMatch(/from\s+["']@anthropic-ai\//);
  });
});

describe("llm-live-checks · provider-prefixed models (the deployed route)", () => {
  test("a bare id is Anthropic, openai:<id> is OpenAI", () => {
    expect(parseModelRef("claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(parseModelRef("anthropic:claude-haiku-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(parseModelRef("openai:gpt-5.6-sol")).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
  });

  test("an unknown provider or an empty model id is refused before any call", () => {
    expect(() => parseModelRef("gemini:x")).toThrow(/unknown provider/);
    expect(() => parseModelRef("openai:")).toThrow(/model id missing/);
    expect(() => parseLiveArgs(["--models", "anthropic:a,bogus:b"])).toThrow(/unknown provider/);
  });

  test("--openai-key-file is read and defaults to openai-key.txt", () => {
    expect(parseLiveArgs([]).openaiKeyFile).toBe("openai-key.txt");
    expect(parseLiveArgs(["--openai-key-file", "/tmp/o.txt"]).openaiKeyFile).toBe("/tmp/o.txt");
  });

  test("the elevated route keeps provider prefixes, so generate and judge hit the OpenAI fallback first", () => {
    expect(
      orderedForFlow(["anthropic:claude-haiku-4-5", "openai:gpt-5.6-sol"], "generate"),
    ).toEqual(["openai:gpt-5.6-sol", "anthropic:claude-haiku-4-5"]);
  });
});
