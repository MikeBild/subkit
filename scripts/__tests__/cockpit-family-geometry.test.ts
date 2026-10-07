import { describe, expect, test } from "bun:test";
import {
  familyGeometry,
  geometryBreaches,
  SMALL_SCREEN_MAX_PX,
  typeScale,
} from "../lib/cockpit-family-geometry.mjs";

const expected = familyGeometry();
const onSpec = {
  title: { ...expected.pageTitle },
  gutter: expected.gutterDesktop,
  buttons: [expected.controlHeight],
  rows: [expected.rowMinHeight, expected.rowMinHeight + 20],
  cardGaps: [expected.cardGap],
  labelledCards: 0,
};

describe("family geometry read from FAMILY-UI.json", () => {
  test("the contract states every value the sweep measures", () => {
    expect(expected.pageTitle).toEqual({ size: 24, line: 32, weight: 600 });
    expect(expected.gutterMobile).toBe(16);
    expect(expected.gutterDesktop).toBe(24);
    expect(expected.controlHeight).toBe(32);
    expect(expected.rowMinHeight).toBe(44);
    expect(expected.cardGap).toBe(2);
  });

  test("a phone card that still stacks label and value is a breach", () => {
    expect(
      geometryBreaches(
        { ...onSpec, gutter: expected.gutterMobile, cardGaps: [12], labelledCards: 3 },
        390,
      ),
    ).toEqual([
      "phone cards 12px apart inside instead of 2px",
      "3 phone card(s) still label their name instead of reading as a row",
    ]);
  });

  test("a type scale that is not size/line weight is refused, not guessed", () => {
    expect(() => typeScale("24px 600")).toThrow();
    expect(typeScale("16px/24px 600")).toEqual({ size: 16, line: 24, weight: 600 });
  });

  test("a page on the contract has no breaches at either width", () => {
    expect(geometryBreaches(onSpec, 1440)).toEqual([]);
    expect(geometryBreaches({ ...onSpec, gutter: expected.gutterMobile }, 390)).toEqual([]);
  });

  test("the title weight is compared, so 650 against 600 is a breach", () => {
    expect(geometryBreaches({ ...onSpec, title: { ...onSpec.title, weight: 650 } }, 1440)).toEqual([
      "page title weight 650 instead of 600",
    ]);
  });

  test("the gutter follows the width: desktop gutter on a phone is a breach", () => {
    expect(
      geometryBreaches({ ...onSpec, gutter: expected.gutterDesktop }, SMALL_SCREEN_MAX_PX),
    ).toEqual(["page gutter 24px instead of 16px"]);
  });

  test("an overridden default button and a squeezed row are both named", () => {
    expect(geometryBreaches({ ...onSpec, buttons: [32, 44, 44], rows: [40] }, 1440)).toEqual([
      "default buttons 44px high instead of 32px",
      "table rows 40px high, below 44px",
    ]);
  });

  test("a page without a title or gutter is measured on what it has", () => {
    expect(geometryBreaches({ title: null, gutter: null, buttons: [], rows: [] }, 1440)).toEqual(
      [],
    );
  });
});
