import { expect, test } from "bun:test";
import { logRing } from "../observability/log-ring.ts";
import { _resetLoggerForTests, errorFields, logger, reconfigureLogger } from "./logger.ts";

test.each(["pretty", "ndjson"] as const)(
  "database payload is absent from %s and ring messages",
  (format) => {
    reconfigureLogger({ format, level: "trace" });
    const stream = format === "pretty" ? process.stderr : process.stdout;
    const original = stream.write;
    let captured = "";
    stream.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof stream.write;
    try {
      logger.error({
        module: "database-safety",
        action: format,
        msg: "Failed query: select private_value\nparams: private-canary",
        cause: {
          code: "22P02",
          message: 'invalid integer: "private-canary"',
          detail: "private-canary",
        },
      });
      logger.error({
        module: "database-safety",
        action: `${format}-error-fields`,
        ...errorFields(
          Object.assign(new Error('invalid integer: "private-canary"'), { code: "22P02" }),
        ),
      });
      expect(captured).not.toContain("private-canary");
      expect(captured).not.toContain("private_value");
      expect(
        JSON.stringify(logRing.tail({ module: "database-safety", action: format })),
      ).not.toContain("private-canary");
    } finally {
      stream.write = original;
      _resetLoggerForTests();
    }
  },
);

test("database error chains preserve classification without native value details", () => {
  const native = Object.assign(new Error('invalid integer: "private-canary"'), { code: "22P02" });
  const wrapped = new Error("Failed query: select private_value", { cause: native });
  expect(JSON.stringify(errorFields(native))).not.toContain("private-canary");
  expect(JSON.stringify(errorFields(wrapped))).not.toContain("private-canary");
});
