import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

const run = <T>(expression: string, nowMs: number | null) =>
  runJs<T>({
    code: `return ${expression};`,
    input: {},
    clock: nowMs === null ? null : { now_ms: nowMs, seed: "fmt-date" },
  }).then((r) => r.output);

const evalJs = (expression: string, nowMs: number | null = null) => run<string>(expression, nowMs);

const errorOf = async (expression: string) => {
  try {
    await evalJs(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

const berlin = (value: string, pattern = "yyyy-MM-dd HH:mm:ss XXX") =>
  evalJs(`sk.fmt.date(${JSON.stringify(value)}, { tz: "Europe/Berlin", pattern: "${pattern}" })`);

describe("sk.fmt.date Europe/Berlin DST boundaries", () => {
  test("spring forward at the last Sunday of March 01:00 UTC", async () => {
    expect(await berlin("2026-03-29T00:59:59Z")).toBe("2026-03-29 01:59:59 +01:00");
    expect(await berlin("2026-03-29T01:00:00Z")).toBe("2026-03-29 03:00:00 +02:00");
  });

  test("fall back at the last Sunday of October 01:00 UTC", async () => {
    expect(await berlin("2026-10-25T00:59:59Z")).toBe("2026-10-25 02:59:59 +02:00");
    expect(await berlin("2026-10-25T01:00:00Z")).toBe("2026-10-25 02:00:00 +01:00");
  });

  test("a year whose March 31 is itself a Sunday", async () => {
    expect(await berlin("2024-03-31T00:59:59Z")).toBe("2024-03-31 01:59:59 +01:00");
    expect(await berlin("2024-03-31T01:00:00Z")).toBe("2024-03-31 03:00:00 +02:00");
    expect(await berlin("2024-03-24T12:00:00Z")).toBe("2024-03-24 13:00:00 +01:00");
  });

  test("offset input is converted to the instant first", async () => {
    expect(await berlin("2026-07-01T23:30:00-02:00")).toBe("2026-07-02 03:30:00 +02:00");
    expect(await berlin("2026-01-15T08:00:00.250+05:30")).toBe("2026-01-15 03:30:00 +01:00");
  });

  test("matches the host IANA database hourly around every transition 1996–2037", async () => {
    const instants: number[] = [];
    for (let year = 1996; year <= 2037; year++) {
      for (const month of [2, 9]) {
        const last = 31 - new Date(Date.UTC(year, month, 31)).getUTCDay();
        const pivot = Date.UTC(year, month, last, 1);
        for (let h = -3; h <= 3; h++)
          instants.push(pivot + h * 3_600_000 - 1000, pivot + h * 3_600_000);
      }
    }
    const actual = await run<string[]>(
      `${JSON.stringify(instants)}.map(function (t) { return sk.fmt.date(t, { tz: "Europe/Berlin", pattern: "yyyy-MM-dd HH:mm:ss" }); })`,
      null,
    );
    const host = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    expect(actual).toEqual(instants.map((t) => host.format(new Date(t))));
  });
});

describe("sk.fmt.date UTC and patterns", () => {
  test("UTC formats the instant unchanged with a Z offset", async () => {
    expect(await evalJs(`sk.fmt.date("2026-03-29T01:00:00Z", { tz: "UTC" })`)).toBe(
      "2026-03-29T01:00:00Z",
    );
    expect(await evalJs(`sk.fmt.date(0, { tz: "UTC", pattern: "dd.MM.yyyy HH:mm:ss" })`)).toBe(
      "01.01.1970 00:00:00",
    );
  });

  test("epoch milliseconds and Date objects are accepted", async () => {
    const ms = Date.UTC(2026, 9, 25, 0, 30);
    expect(await evalJs(`sk.fmt.date(${ms}, { tz: "Europe/Berlin", pattern: "HH:mm" })`)).toBe(
      "02:30",
    );
    expect(await evalJs(`sk.fmt.date(new Date(${ms}), { tz: "UTC", pattern: "H:mm" })`)).toBe(
      "0:30",
    );
  });

  test("German names, unpadded tokens and quoted literals", async () => {
    expect(
      await evalJs(
        `sk.fmt.date("2026-03-29T01:30:00Z", { tz: "Europe/Berlin", locale: "de", pattern: "EEEE, d. MMMM yyyy, HH:mm 'Uhr'" })`,
      ),
    ).toBe("Sonntag, 29. März 2026, 03:30 Uhr");
    expect(
      await evalJs(
        `sk.fmt.date("2026-10-06T10:00:00Z", { tz: "UTC", locale: "de", pattern: "EEE d. MMM" })`,
      ),
    ).toBe("Di. 6. Okt.");
    expect(
      await evalJs(`sk.fmt.date("2026-10-06T10:00:00Z", { tz: "UTC", pattern: "''d''" })`),
    ).toBe("'6'");
  });

  test("English names by default", async () => {
    expect(
      await evalJs(`sk.fmt.date("2026-05-01T12:00:00Z", { tz: "UTC", pattern: "EEEE MMMM M/d" })`),
    ).toBe("Friday May 5/1");
  });

  test("date-only input keeps its calendar date in every zone", async () => {
    expect(await evalJs(`sk.fmt.date("2026-03-29", { tz: "Europe/Berlin" })`)).toBe("2026-03-29");
    expect(
      await evalJs(
        `sk.fmt.date("1980-02-29", { tz: "Europe/Berlin", locale: "de", pattern: "dd.MM.yyyy" })`,
      ),
    ).toBe("29.02.1980");
  });

  test("output never depends on the execution clock", async () => {
    const expression = `sk.fmt.date("2026-10-25T01:00:00Z", { tz: "Europe/Berlin" })`;
    expect(await evalJs(expression, 0)).toBe(await evalJs(expression, Date.UTC(2031, 0, 1)));
  });
});

describe("sk.fmt.date invalid input", () => {
  test("a date-time without an offset is rejected instead of guessing a zone", async () => {
    expect(await errorOf(`sk.fmt.date("2026-03-29T02:30:00", { tz: "Europe/Berlin" })`)).toContain(
      "with Z or an offset",
    );
  });

  test("malformed or impossible values throw", async () => {
    for (const value of [
      `"2026-02-30T10:00:00Z"`,
      `"2026-13-01"`,
      `"2026-03-29T24:00:00Z"`,
      `"29.03.2026"`,
      `"not a date"`,
      `NaN`,
      `Infinity`,
      `null`,
      `true`,
      `{}`,
      `new Date(NaN)`,
    ]) {
      expect(await errorOf(`sk.fmt.date(${value}, { tz: "UTC" })`)).toContain("sk.fmt.date:");
    }
  });

  test("tz is required and must be known", async () => {
    expect(await errorOf(`sk.fmt.date(0)`)).toContain("options.tz is required");
    expect(await errorOf(`sk.fmt.date(0, { tz: "America/New_York" })`)).toContain(
      'unsupported tz "America/New_York"',
    );
  });

  test("unknown locale and unknown pattern letters throw", async () => {
    expect(await errorOf(`sk.fmt.date(0, { tz: "UTC", locale: "fr" })`)).toContain(
      'unsupported locale "fr"',
    );
    expect(await errorOf(`sk.fmt.date(0, { tz: "UTC", pattern: "YYYY-MM-DD" })`)).toContain(
      'unsupported pattern token "YYYY"',
    );
    expect(await errorOf(`sk.fmt.date(0, { tz: "UTC", pattern: "HH 'Uhr" })`)).toContain(
      "unterminated quote",
    );
  });

  test("time tokens on a date-only value throw", async () => {
    expect(
      await errorOf(`sk.fmt.date("2026-03-29", { tz: "UTC", pattern: "dd.MM.yyyy HH:mm" })`),
    ).toContain('no time for token "HH"');
  });

  test("Berlin instants before the EU rule throw", async () => {
    expect(await errorOf(`sk.fmt.date("1995-06-01T12:00:00Z", { tz: "Europe/Berlin" })`)).toContain(
      "sk.date.format",
    );
  });

  test("the Date locale guard points at sk.fmt.date", async () => {
    expect(await errorOf(`new Date(0).toLocaleDateString("de-DE")`)).toContain("sk.fmt.date");
  });
});
