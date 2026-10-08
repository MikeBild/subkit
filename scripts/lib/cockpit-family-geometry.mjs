import FAMILY_UI from "../../FAMILY-UI.json" with { type: "json" };

export function typeScale(spec) {
  const match = /^(\d+)px\/(\d+)px (\d+)$/.exec(String(spec));
  if (!match)
    throw new Error(`FAMILY-UI typography "${spec}" does not read "<size>px/<line>px <weight>"`);
  return { size: Number(match[1]), line: Number(match[2]), weight: Number(match[3]) };
}

export const SMALL_SCREEN_MAX_PX = 639;

export function familyGeometry(contract = FAMILY_UI) {
  return {
    pageTitle: typeScale(contract.typography.pageTitle),
    gutterMobile: contract.geometry.gutterMobilePx,
    gutterDesktop: contract.geometry.gutterDesktopPx,
    controlHeight: contract.geometry.controlHeightPx,
    rowMinHeight: contract.geometry.tableRowMinPx,
    cardGap: contract.collections.mobileCardGapPx,
  };
}

export function geometryBreaches(measured, viewportWidth, expected = familyGeometry()) {
  const breaches = [];
  if (measured.title) {
    for (const key of ["size", "line", "weight"])
      if (measured.title[key] !== expected.pageTitle[key])
        breaches.push(
          `page title ${key} ${measured.title[key]} instead of ${expected.pageTitle[key]}`,
        );
  }
  if (measured.gutter !== null && measured.gutter !== undefined) {
    const want =
      viewportWidth <= SMALL_SCREEN_MAX_PX ? expected.gutterMobile : expected.gutterDesktop;
    if (measured.gutter !== want)
      breaches.push(`page gutter ${measured.gutter}px instead of ${want}px`);
  }
  const buttons = [...new Set(measured.buttons ?? [])].filter(
    (height) => height !== expected.controlHeight,
  );
  if (buttons.length > 0)
    breaches.push(
      `default buttons ${buttons.join("/")}px high instead of ${expected.controlHeight}px`,
    );
  const rows = [...new Set(measured.rows ?? [])].filter((height) => height < expected.rowMinHeight);
  if (rows.length > 0)
    breaches.push(`table rows ${rows.join("/")}px high, below ${expected.rowMinHeight}px`);
  const gaps = [...new Set(measured.cardGaps ?? [])].filter((gap) => gap !== expected.cardGap);
  if (gaps.length > 0)
    breaches.push(`phone cards ${gaps.join("/")}px apart inside instead of ${expected.cardGap}px`);
  const labelled = measured.labelledCards ?? 0;
  if (labelled > 0)
    breaches.push(`${labelled} phone card(s) still label their name instead of reading as a row`);
  return breaches;
}

export function measureFamilyGeometry() {
  const scope = document.querySelector('[data-testid="page-content"]');
  if (!scope)
    return { title: null, gutter: null, buttons: [], rows: [], cardGaps: [], labelledCards: 0 };
  const shown = (node) => node.getClientRects().length > 0 && !node.closest("[inert]");
  const heading = scope.querySelector('[data-slot="page-title-row"] h1');
  const style = heading ? getComputedStyle(heading) : null;
  const main = scope.querySelector("main[data-page-kind]");
  const padded = main && main.dataset.pageKind !== "workspace" ? main.firstElementChild : null;
  const cards = [...scope.querySelectorAll("[data-family-collection-mobile-card]")].filter(shown);
  return {
    title: style
      ? {
          size: Number.parseFloat(style.fontSize),
          line: Number.parseFloat(style.lineHeight),
          weight: Number(style.fontWeight),
        }
      : null,
    gutter:
      padded instanceof HTMLElement
        ? Number.parseFloat(getComputedStyle(padded).paddingLeft)
        : null,
    buttons: [...scope.querySelectorAll('[data-slot="button"][data-size="default"]')]
      .filter(shown)
      .map((node) => Math.round(node.getBoundingClientRect().height)),
    rows: [...scope.querySelectorAll('[data-slot="table-body"] tr[data-slot="table-row"]')]
      .filter(shown)
      .map((node) => Math.round(node.getBoundingClientRect().height)),
    cardGaps: cards.map((node) => Number.parseFloat(getComputedStyle(node).rowGap)),
    labelledCards: cards.filter((node) => !node.querySelector('[data-family-slot="card-title"]'))
      .length,
  };
}

export async function assertFamilyGeometry(page, label, viewportWidth) {
  const measured = await page.evaluate(measureFamilyGeometry);
  const breaches = geometryBreaches(measured, viewportWidth);
  if (breaches.length > 0)
    throw new Error(`${label} leaves the family geometry: ${breaches.join("; ")}`);
}
