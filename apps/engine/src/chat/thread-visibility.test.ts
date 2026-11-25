import { describe, expect, test } from "bun:test";
import { chatThreadVisibility } from "./thread-visibility.ts";

describe("chatThreadVisibility", () => {
  test("a Slack channel thread is shared with the team", () => {
    expect(chatThreadVisibility({ platform: "slack", channel_id: "C0123" })).toBe("team");
  });

  test("a Slack direct message stays private", () => {
    expect(chatThreadVisibility({ platform: "slack", channel_id: "D0123" })).toBe("private");
  });

  test("a Google Chat space is shared, a direct message is not", () => {
    expect(chatThreadVisibility({ platform: "google_chat", channel_id: "spaces/AAA" })).toBe(
      "team",
    );
    expect(
      chatThreadVisibility({
        platform: "google_chat",
        channel_id: "spaces/BBB",
        is_direct_message: true,
      }),
    ).toBe("private");
  });
});
