import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

const run = <T>(code: string, input: unknown): Promise<T> =>
  runJs<T>({ code, input, clock: null }).then((r) => r.output as T);

const CODE = "return sk.rfc3339Parts(input.s);";

describe("sk.rfc3339Parts", () => {
  test("positive offset (the Google Calendar dateTime shape)", async () => {
    const out = await run(CODE, { s: "2026-07-04T10:00:00+02:00" });
    expect(out).toEqual({
      date: "2026-07-04",
      time: "10:00:00",
      offset: "+02:00",
      wall: "2026-07-04 10:00",
    });
  });

  test("negative half-hour offset", async () => {
    const out = await run(CODE, { s: "2026-01-15T08:30:00-07:30" });
    expect(out).toEqual({
      date: "2026-01-15",
      time: "08:30:00",
      offset: "-07:30",
      wall: "2026-01-15 08:30",
    });
  });

  test("Zulu time and fractional seconds", async () => {
    const out = await run(CODE, { s: "2026-07-04T23:59:59.123Z" });
    expect(out).toEqual({
      date: "2026-07-04",
      time: "23:59:59.123",
      offset: "Z",
      wall: "2026-07-04 23:59",
    });
  });

  test("date-only input (all-day event start.date) yields null time/offset", async () => {
    const out = await run(CODE, { s: "2026-07-04" });
    expect(out).toEqual({ date: "2026-07-04", time: null, offset: null, wall: "2026-07-04" });
  });

  test("offset-less local date-time keeps offset null (never invents one)", async () => {
    const out = await run(CODE, { s: "2026-07-04T10:00" });
    expect(out).toEqual({
      date: "2026-07-04",
      time: "10:00",
      offset: null,
      wall: "2026-07-04 10:00",
    });
  });

  test("invalid input throws — a silent reformat is the lossy shape this prevents", async () => {
    await expect(run(CODE, { s: "next Tuesday" })).rejects.toThrow(/rfc3339Parts/);
    await expect(run(CODE, { s: "2026-7-4T10:00:00Z" })).rejects.toThrow(/rfc3339Parts/);
  });
});
