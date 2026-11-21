import { describe, expect, test } from "bun:test";
import { command, harness, ON, ok, snap, tree } from "./driver.fixture.ts";
import { decodePng, encodePng, type RgbaImage } from "./png.ts";

describe("computer screenshots", () => {
  test("a screenshot is refused without Screen Recording and never captured", async () => {
    const h = harness({}, {}, { ...ON, permissions: { accessibility: true, screen: false } });
    expect(await h.run(command("computer.screenshot", { window_id: "w-1" }))).toMatchObject({
      code: "permission_missing",
    });
    expect(h.fake.commands()).not.toContain("screenshot");
  });

  test("a screenshot of one window is redacted before it leaves the runner", async () => {
    const white: RgbaImage = {
      width: 800,
      height: 600,
      pixels: new Uint8Array(800 * 600 * 4).fill(255),
    };
    const shot = ok("screenshot", {
      format: "png",
      width: 800,
      height: 600,
      scale_factor: 2,
      data: encodePng(white).toString("base64"),
    });
    const h = harness({ screenshot: shot });
    const result = await h.run(command("computer.screenshot", { window_id: "w-1" }));
    if (result.status !== "done") throw new Error(JSON.stringify(result));
    const output = result.output as {
      data: string;
      sha256: string;
      redacted: number;
      width: number;
    };
    expect(output.redacted).toBe(1);
    const shown = h.progress.find((item) => item.progress.type === "screenshot")?.progress;
    expect(shown?.type === "screenshot" && Buffer.from(shown.png).toString("base64")).toBe(
      output.data,
    );
    expect(result.evidence.screenshot_ref).toBe(`sha256:${output.sha256}`);
    const image = decodePng(Buffer.from(output.data, "base64")) as RgbaImage;
    const at = (x: number, y: number) => [
      ...image.pixels.subarray((y * 800 + x) * 4, (y * 800 + x) * 4 + 4),
    ];
    expect(at(30, 50)).toEqual([0, 0, 0, 255]);
    expect(at(750, 550)).toEqual([255, 255, 255, 255]);
    expect(at(400, 300)).toEqual([255, 255, 255, 255]);
    expect(h.fake.calls().find((call) => call.argv[0] === "screenshot")?.argv).toEqual([
      "screenshot",
      "--window-id",
      "w-1",
    ]);
  });

  test("no screenshot while a password field has focus", async () => {
    const h = harness({ snapshot: snap(tree(["secure", "focused"])) });
    const result = await h.run(command("computer.screenshot", { window_id: "w-1" }));
    expect(result).toMatchObject({ status: "refused", code: "secure_focus" });
    expect(h.fake.commands()).not.toContain("screenshot");
  });

  test("an unreadable screenshot is never passed on", async () => {
    const h = harness({
      screenshot: ok("screenshot", {
        format: "png",
        width: 1,
        height: 1,
        scale_factor: 2,
        data: "AAAA",
      }),
    });
    expect(await h.run(command("computer.screenshot", { window_id: "w-1" }))).toMatchObject({
      status: "failed",
      code: "screenshot_unreadable",
    });
  });
});
