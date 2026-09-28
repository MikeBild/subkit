import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { findVisibleUuids, textOutsidePayloads } from "../lib/cockpit-visible-uuids.mjs";

function visible(html: string): string[] {
  const { document } = new JSDOM(`<body>${html}</body>`).window;
  return findVisibleUuids(textOutsidePayloads(document.body)).map((entry) => entry.value);
}

describe("identifiers where a person reads", () => {
  test("any UUID is found, not only the one the fixture knows", () => {
    expect(
      visible(
        "<h3>6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41</h3><p>Version 3b8a0c1d-9e2f-4a6b-8c7d-5e4f3a2b1c0d</p>",
      ),
    ).toEqual(["6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41", "3b8a0c1d-9e2f-4a6b-8c7d-5e4f3a2b1c0d"]);
  });

  test("upper case is still an identifier", () => {
    expect(visible("<span>6F1C2B9E-4D7A-4E21-9B3C-0A5D8E7F6C41</span>")).toHaveLength(1);
  });

  test("an identifier inside a fenced block is the payload and is exempt", () => {
    expect(visible('<pre>{ "workflow_id": "6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41" }</pre>')).toEqual(
      [],
    );
  });

  test("monospace mid-sentence is not the exemption", () => {
    expect(visible("<p>Connector <code>6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41</code></p>")).toEqual([
      "6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41",
    ]);
  });

  test("hidden text counts — a closed drawer or a screen-reader span is still read", () => {
    expect(
      visible(
        '<details><summary>Mehr</summary>6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41</details><span class="sr-only">3b8a0c1d-9e2f-4a6b-8c7d-5e4f3a2b1c0d</span>',
      ),
    ).toHaveLength(2);
  });

  test("a shortened identifier and a title attribute pass", () => {
    expect(visible('<span title="6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41">6f1c2b9e…</span>')).toEqual(
      [],
    );
  });

  test("the same identifier twice is reported once", () => {
    expect(
      visible(
        "<p>6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41</p><p>6f1c2b9e-4d7a-4e21-9b3c-0a5d8e7f6c41</p>",
      ),
    ).toHaveLength(1);
  });
});
