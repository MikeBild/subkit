// sk.fmt and the toLocaleString locale guard.
//
// Regression origin: a German page shipped "+9.2 %" and "35606 USD" to
// production. The transform called `toLocaleString("de-DE")`, which formats
// correctly under Node but is a no-op here — QuickJS has no Intl/ECMA-402, so
// the locale is accepted and ignored. The bug stayed invisible until the
// rendered page was read. sk.fmt provides the formatting; the guard makes the
// silent path fail loudly.

import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

const evalJs = (expression: string) =>
  runJs<string>({ code: `return ${expression};`, input: {}, clock: null }).then((r) => r.output);

const errorOf = async (expression: string) => {
  try {
    await evalJs(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe("sk.fmt.number", () => {
  test("German decimal comma and thousands point", async () => {
    expect(await evalJs(`sk.fmt.de(35606)`)).toBe("35.606");
    expect(await evalJs(`sk.fmt.number(9.15, { locale: "de", digits: 1 })`)).toBe("9,2");
    expect(await evalJs(`sk.fmt.number(-1234.5, { locale: "de", digits: 2 })`)).toBe("-1.234,50");
    expect(await evalJs(`sk.fmt.number(0.95, { locale: "de", digits: 1 })`)).toBe("1,0");
  });

  test("English separators", async () => {
    expect(await evalJs(`sk.fmt.number(1234567, { locale: "en" })`)).toBe("1,234,567");
  });

  test("grouping can be turned off for machine-readable output", async () => {
    expect(await evalJs(`sk.fmt.number(1234567, { locale: "de", grouping: false })`)).toBe(
      "1234567",
    );
  });

  test("an unknown locale fails instead of guessing", async () => {
    expect(await errorOf(`sk.fmt.number(1, { locale: "fr" })`)).toContain("unsupported locale");
  });
});

describe("toLocaleString locale guard", () => {
  test("a locale argument throws, because it would be ignored", async () => {
    const message = await errorOf(`(9.2).toLocaleString("de-DE")`);
    expect(message).toContain("no Intl/ECMA-402");
    expect(message).toContain("sk.fmt.number");
  });

  test("Date locale methods are guarded too", async () => {
    expect(await errorOf(`new Date(0).toLocaleDateString("de-DE")`)).toContain("no Intl/ECMA-402");
  });

  test("the argument-less call still works — it is not locale-aware", async () => {
    expect(await errorOf(`(9.2).toLocaleString()`)).toBeNull();
  });

  test("options alone throw too, even with no locale named", async () => {
    // The hole a first-argument-only guard leaves: this names no locale but
    // still asks for Intl behaviour. Node gives "50 %"; unguarded, the sandbox
    // drops the options and returns "0.5" — silently wrong, which is precisely
    // what the guard exists to prevent.
    expect(await errorOf(`(0.5).toLocaleString(undefined, { style: "percent" })`)).toContain(
      "no Intl/ECMA-402",
    );
  });

  test("Date options alone throw as well", async () => {
    expect(
      await errorOf(`new Date(0).toLocaleDateString(undefined, { dateStyle: "long" })`),
    ).toContain("no Intl/ECMA-402");
  });
});
