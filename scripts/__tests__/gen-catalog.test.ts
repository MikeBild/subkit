import { describe, expect, test } from "bun:test";

describe("connector recipe catalog", () => {
  test("omits the owning connector and names additional required connectors", () => {
    const result = Bun.spawnSync([process.execPath, "scripts/gen-catalog.ts"], {
      cwd: new URL("../../", import.meta.url).pathname,
    });
    expect(result.exitCode).toBe(0);
    const catalog = result.stdout.toString();
    const square = catalog.split("### Square (`square`)\n")[1]?.split("\n### ")[0];
    expect(square).toBeDefined();
    for (const slug of [
      "create-customer",
      "inventory-counts",
      "list-orders",
      "list-team-members",
      "refund-payment",
    ]) {
      const row = square?.split("\n").find((line) => line.startsWith(`| \`${slug}\` |`));
      expect(row).toEndWith("| request | — |");
    }
    expect(catalog).not.toContain("`undefined`");
    expect(
      catalog.split("\n").find((line) => line.startsWith("| `on-charge-failed-notify-slack` |")),
    ).toEndWith("| webhook | `slack` |");
  });
});
