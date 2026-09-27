// §1 on a rendered KPI card: how many ways in it must offer.
//
// Stated here on its own rather than imported from the cockpit's model: a
// check that runs the product's rule agrees with the product by construction.
//
// "Kein Zähler ohne Link" was once measured as "every tile, one link" — which
// demanded a link under "Blockiert: 0" and handed the reader an empty list.
// Then it was measured as "a zero never links", which is right for a COUNT and
// wrong for everything else: execution success at 0 %, connector health at
// 0 %, a health score of 0 are the worst states a tile can be in, and "Kein Rot
// ohne Weg zur Ursache" demands the way in exactly there.
//
// So: a counted zero has nothing to open; a ratio, score or duration leads to
// its cause whatever its value; a value that could not be read keeps its way
// in only when it is red (the health state is critical on blocked work alone,
// with no score). A card that names no kind is held to the count rule.

/**
 * @param {{ kind?: string | null, value: number, unread: boolean, severity?: string | null }} card
 * @returns {0 | 1}
 */
export function expectedKpiLinks(card) {
  const red = card.severity === "critical" || card.severity === "urgent";
  if (card.unread) return red ? 1 : 0;
  const isCount = !card.kind || card.kind === "count";
  if (isCount) return card.value > 0 ? 1 : 0;
  return 1;
}
