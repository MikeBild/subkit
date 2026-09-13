import { describe, expect, test } from "bun:test";
import { Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";

import { KEYS, renderInk, stripAnsi } from "./ink.tsx";

function Counter(): React.ReactElement {
  const [n, setN] = useState(0);
  useInput((input, key) => {
    if (input === "+" || key.return) setN((x) => x + 1);
    if (input === "-") setN((x) => x - 1);
  });
  return <Text>count={n}</Text>;
}

describe("renderInk helper", () => {
  test("initial render is visible in text()", async () => {
    const ui = renderInk(<Counter />);
    try {
      expect(ui.text()).toContain("count=0");
    } finally {
      ui.unmount();
    }
  });

  test("type() advances the component's state", async () => {
    const ui = renderInk(<Counter />);
    try {
      await ui.type("+");
      await ui.waitFor((t) => t.includes("count=1"));
      expect(ui.text()).toContain("count=1");
    } finally {
      ui.unmount();
    }
  });

  test("press('enter') routes via KEYS table", async () => {
    const ui = renderInk(<Counter />);
    try {
      await ui.press("enter");
      await ui.waitFor((t) => t.includes("count=1"));
    } finally {
      ui.unmount();
    }
  });

  test("waitFor throws with the last frame when predicate never holds", async () => {
    const ui = renderInk(<Counter />);
    try {
      await expect(
        ui.waitFor((t) => t.includes("count=99"), { tries: 3, label: "never" }),
      ).rejects.toThrow(/never timed out/);
    } finally {
      ui.unmount();
    }
  });

  test("KEYS exposes canonical byte sequences", () => {
    expect(KEYS.enter).toBe("\r");
    expect(KEYS.esc).toBe("\u001B");
    expect(KEYS.up).toBe("\u001B[A");
    expect(KEYS.ctrlC).toBe("\x03");
  });

  test("stripAnsi removes color codes and cursor sequences", () => {
    expect(stripAnsi("\u001B[31mred\u001B[0m")).toBe("red");
    expect(stripAnsi("\u001B[1;33mbold yellow\u001B[0m mixed \u001B[2Jclear")).toBe(
      "bold yellow mixed clear",
    );
  });
});
