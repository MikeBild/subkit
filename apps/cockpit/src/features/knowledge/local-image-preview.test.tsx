import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalImagePreview } from "./local-image-preview";

test("a local image is decoded onto a canvas, never handed to the page as a URL", () => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  const markup = renderToStaticMarkup(
    <LocalImagePreview file={file} fallback={<p>no preview</p>} />,
  );
  expect(markup).toContain("<canvas");
  expect(markup).toContain('role="img"');
  expect(markup).toContain('aria-label="shot.png"');
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("blob:");
});
