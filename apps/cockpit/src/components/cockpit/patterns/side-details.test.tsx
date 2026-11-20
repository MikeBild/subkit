import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sideTestIds } from "./side-details";

function Named({ testId }: { testId?: string }) {
  return <b data-testid={testId}>named</b>;
}

describe("status mirrored into the side panel", () => {
  test("every selector in the mirrored line gets its own name", () => {
    const line = (
      <>
        <span data-testid="connector-strip-state">Anmeldung abgelaufen</span>
        {" · "}
        <span>
          <em data-testid="connector-strip-detail">seit gestern</em>
          <Named testId="connector-strip-chip" />
        </span>
      </>
    );
    const page = renderToStaticMarkup(<p>{line}</p>);
    const side = renderToStaticMarkup(<p>{sideTestIds(line)}</p>);
    expect(page).toContain('data-testid="connector-strip-state"');
    expect(side).toContain('data-testid="side-connector-strip-state"');
    expect(side).toContain('data-testid="side-connector-strip-detail"');
    expect(side).toContain('data-testid="side-connector-strip-chip"');
    expect(side).not.toContain('data-testid="connector-strip');
    expect(side).toContain("Anmeldung abgelaufen</span> · <span>");
  });

  test("plain text and elements without a selector pass through", () => {
    expect(renderToStaticMarkup(<p>{sideTestIds("Aktiv")}</p>)).toBe("<p>Aktiv</p>");
    expect(renderToStaticMarkup(<p>{sideTestIds(<i>x</i>)}</p>)).toBe("<p><i>x</i></p>");
    expect(renderToStaticMarkup(<p>{sideTestIds(null)}</p>)).toBe("<p></p>");
  });
});
