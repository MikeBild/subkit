/**
 * Whose console answered? — the question a port cannot answer.
 *
 * A port says that somebody is listening. Never who, and never since when. On
 * three ports of this family orphans of dead sessions were listening; on one of
 * them a build from before this marker existed, 13 days old. The visual sweep
 * pointed at such a port without asking anything, so 296 screenshots of a
 * foreign console would have been indistinguishable from our own.
 *
 * This module is IMPORTABLE on purpose, and the decision is a pure function.
 * A guard that is only pinned as source text is not a guard: a sister repo's
 * identity rule demanded "the line is present", and an implementation that left
 * the line in place while checking the wrong document passed 12/0 with the hole
 * fully open. `tests/contract/cockpit-identity.test.ts` runs `identityProblem`
 * against fixtures instead — including the ones it must reject.
 *
 * The convention check READS the marker from here rather than carrying its own
 * copy. It used to carry one, and both copies held the same defect — which is
 * what two versions of one decision are for. Its assert stays behind, because
 * its wording is pinned line by line by
 * `tests/contract/konvention-check-kennung.test.ts` and is German
 * (LOCAL-SK-SPRACHE-IM-CODE); the READER is what the two shared and what is
 * shared now.
 */
import { readFileSync } from "node:fs";

/** The attribute the console stamps on its document. */
export const IDENTITY_META = "cockpit-product";

/**
 * The single definition site of the expected value. Derived, never typed: a
 * renamed attribute must then report "this repository lost its marker" instead
 * of "foreign document" about our own console.
 */
export const IDENTITY_SOURCE = new URL("../../apps/cockpit/index.html", import.meta.url);

/**
 * A document's comments, which are prose and not its stamp.
 *
 * Load-bearing. Every console in this family explains the marker in a comment
 * directly ABOVE it, and prose that quotes the line as an example puts a second
 * `content="…"` into the document — ahead of the real one. `markerIn` used to
 * answer with the first thing it found anywhere in the text. A built WorkKit
 * console whose prose quoted `content="SubKit"` therefore passed as ours: the
 * sweep exited 0 and wrote 296 screenshots of a foreign cockpit, and the
 * convention check measured 27 routes of it under the heading "identity SubKit".
 *
 * The unterminated `<!--` is swallowed to the end on purpose, the way a browser
 * swallows it: a document whose markup cannot be delimited has no readable
 * stamp, and "unreadable" must come out as "not identified", never as a guess.
 */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * A document's marker, or null if it carries none.
 *
 * Read from the MARKUP only. A fixture for this function has to carry the shape
 * of a real shell, prose comment included — in a minimal shell the marker is the
 * first occurrence in the file, which is the one case the old reader got right.
 */
export function markerIn(html) {
  return (
    new RegExp(`<meta[^>]+name="${IDENTITY_META}"[^>]+content="([^"]+)"`).exec(
      html.replace(HTML_COMMENT, ""),
    )?.[1] ?? null
  );
}

/**
 * A document's title, for naming what answered instead of only rejecting it.
 *
 * Past the comments as well: this string is printed in the sentence that names
 * a foreign console, and a title quoted in prose would let that console be
 * announced under a name it does not carry.
 */
export function titleIn(html) {
  return (
    /<title>([^<]*)<\/title>/.exec(html.replace(HTML_COMMENT, ""))?.[1]?.trim() || "(no <title>)"
  );
}

/** What this repository calls its console, read from the definition site. */
export function expectedIdentity(source = IDENTITY_SOURCE) {
  return markerIn(readFileSync(source, "utf8"));
}

/**
 * Why the stand must not be measured — or null when it may be.
 *
 * Returns a sentence rather than throwing, so a caller can decide its own error
 * type and its own exit code, and so a test can drive every branch.
 */
export function identityProblem({ served, expected, baseUrl }) {
  if (expected === null) {
    return (
      `apps/cockpit/index.html no longer carries <meta name="${IDENTITY_META}" content="…">. ` +
      "The expected identity is derived from that file and now has none — a finding about THIS " +
      `repository, and no statement about whatever answers on ${baseUrl}.`
    );
  }
  const delivered = markerIn(served);
  if (delivered === null) {
    return (
      `this is not ${expected}: the document on ${baseUrl} carries no ` +
      `<meta name="${IDENTITY_META}">. Its title reads "${titleIn(served)}". Either a sister ` +
      "console holds the port, or it is a build from before the marker existed. Both would be " +
      `photographed as ${expected}.`
    );
  }
  if (delivered !== expected) {
    return (
      `this is not ${expected} but ${delivered}: the document on ${baseUrl} calls itself ` +
      `"${delivered}", apps/cockpit/index.html names "${expected}". Nothing was photographed.`
    );
  }
  return null;
}
