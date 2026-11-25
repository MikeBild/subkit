import { describe, expect, test } from "bun:test";
import { barHeights, LevelMeter } from "@ui/atoms/level-meter";
import { RecordingIndicator } from "@ui/molecules/recording-indicator";
import { renderToStaticMarkup } from "react-dom/server";

describe("LevelMeter", () => {
  test("bars rest at a floor when silent and grow with the level", () => {
    expect(barHeights(0)).toEqual([20, 20, 20, 20, 20]);
    expect(barHeights(1)).toEqual([56, 84, 100, 76, 60]);
    expect(barHeights(5)).toEqual(barHeights(1));
  });

  test("is hidden from assistive technology", () => {
    expect(renderToStaticMarkup(<LevelMeter level={0.5} />)).toContain('aria-hidden="true"');
  });
});

describe("RecordingIndicator", () => {
  test("announces recording with elapsed time", () => {
    const html = renderToStaticMarkup(
      <RecordingIndicator phase="recording" label="Listening" elapsed="0:07" level={0.4} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Listening");
    expect(html).toContain("0:07");
  });

  test("shows only the label while working", () => {
    const html = renderToStaticMarkup(
      <RecordingIndicator phase="working" label="Transcribing" elapsed="0:07" />,
    );
    expect(html).toContain("Transcribing");
    expect(html).not.toContain("0:07");
  });
});
