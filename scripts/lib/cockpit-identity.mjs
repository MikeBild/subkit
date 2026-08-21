/**
 * Whose console answered? — the question a port cannot answer.
 *
 * A port says that somebody is listening. Never who, and never since when. On
 * three ports of this family orphans of dead sessions were listening; on one of
 * them a build from before this marker existed, 13 days old. The visual sweep
 * pointed at such a port without asking anything, so 296 screenshots of a
 * foreign console would have been indistinguishable from our own.
 *
 * ONE READER, and it is the browser.
 *
 * This module used to answer the question with a regex over the HTTP text while
 * the frames came out of Chromium's parse. Two readers of one document is two
 * answers, and the gap between them is a document that photographs as WorkKit
 * and reads as SubKit. Ten such shapes were measured in one day, each closed by
 * a sharper regex, and the tenth was OPENED by the repair of the ninth: the
 * comment stripper introduced for prose swallowed the foreign marker behind an
 * abruptly closed `<!-->`, and the sweep wrote 296 frames of a WorkKit cockpit
 * at exit 0. Four shapes that still beat a regex are pinned in
 * `tests/contract/cockpit-identity.test.ts`, served over real HTTP.
 *
 * `readIdentity` asks the page. Same engine, same parse, same document as the
 * screenshots — so reader and photographer cannot disagree, and the shapes stop
 * being cases at all.
 *
 * `markerIn` remains for the one place where no browser exists: the definition
 * site on disk. There the rule is FAIL-SAFE — anything a parser could read
 * differently from a string comparison yields `null`, which every caller turns
 * into "not identified", never into a guessed name.
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
 * What the page says it is — read by the engine that takes the frames.
 *
 * `getElementsByTagName` in document order and `.name`/`.content` off the
 * parsed element: that is the parser's own answer, including the two shapes a
 * text reader gets backwards. With `content="WorkKit" content="SubKit"` the
 * parser keeps the FIRST and a reader searching for `content=` after `name=`
 * finds the second; with `name="cockpit&#45;product"` the parser decodes the
 * character reference in the attribute NAME and a string comparison does not.
 */
export async function readIdentity(page) {
  return page.evaluate((name) => {
    const meta = [...document.getElementsByTagName("meta")].find(
      (candidate) => candidate.name === name,
    );
    return {
      marker: meta?.content || null,
      title: document.title.trim() || "(no <title>)",
    };
  }, IDENTITY_META);
}

/**
 * A document's comments, or null when this file cannot say where they end.
 *
 * `<!-->` and `<!--->` are COMPLETE, abruptly closed, empty comments; `--!>`
 * closes one early; an unterminated `<!--` runs to the end of the file. Each of
 * them puts the parser's idea of "inside a comment" somewhere else than a
 * `<!--[\s\S]*?-->` regex puts it, and the first of them cost a full sweep of a
 * foreign cockpit. None of them is reconstructed here — a document whose markup
 * cannot be delimited by this reader has no readable stamp, full stop.
 */
function withoutComments(html) {
  let out = "";
  let index = 0;
  for (;;) {
    const open = html.indexOf("<!--", index);
    if (open === -1) return out + html.slice(index);
    out += html.slice(index, open);
    if (/^<!--(>|->)/.test(html.slice(open))) return null;
    const close = html.indexOf("-->", open + 4);
    if (close === -1) return null;
    if (html.slice(open, close).includes("--!>")) return null;
    index = close + 3;
  }
}

/**
 * A document's marker as far as TEXT can be trusted with it, or null.
 *
 * Only for the definition site on disk, where there is no browser to ask. Every
 * branch that is not "exactly one unambiguous marker" answers null, because the
 * only safe thing to do with a document two readers would read differently is
 * to refuse to name it. That refusal is exit 2 at every caller — an absent
 * measurement, never a guessed identity.
 */
export function markerIn(html) {
  const body = withoutComments(html);
  if (body === null) return null;
  const found = [];
  for (const [, attributes] of body.matchAll(/<meta\b([^>]*)>/gi)) {
    const names = [...attributes.matchAll(/\bname\s*=\s*"([^"]*)"/gi)].map(([, value]) => value);
    // A character reference in the attribute NAME is decoded by the parser and
    // not by a string comparison, so anything that could decode makes the whole
    // document unreadable rather than "not the marker".
    if (names.some((name) => name.includes("&"))) return null;
    // A quoting style this reader cannot see is the same situation.
    if (/\bname\s*=/i.test(attributes) && names.length === 0) return null;
    if (!names.includes(IDENTITY_META)) continue;
    if (names.length > 1) return null;
    const contents = [...attributes.matchAll(/\bcontent\s*=\s*"([^"]*)"/gi)].map(
      ([, value]) => value,
    );
    if (contents.length !== 1) return null;
    found.push(contents[0]);
  }
  if (found.length !== 1) return null;
  return found[0] || null;
}

/** What this repository calls its console, read from the definition site. */
export function expectedIdentity(source = IDENTITY_SOURCE) {
  return markerIn(readFileSync(source, "utf8"));
}

/**
 * Why the stand must not be measured — or null when it may be.
 *
 * Takes what the PARSER read, not a document to re-read: whoever calls this has
 * a page open, and re-reading the text here would be the second reader all over
 * again. Returns a sentence rather than throwing, so a caller can decide its
 * own error type and its own exit code, and so a test can drive every branch.
 */
export function identityProblem({ delivered, title, expected, baseUrl }) {
  if (expected === null) {
    return (
      `apps/cockpit/index.html no longer carries one unambiguous ` +
      `<meta name="${IDENTITY_META}" content="…">. The expected identity is derived from that ` +
      `file and now has none — a finding about THIS repository, and no statement about whatever ` +
      `answers on ${baseUrl}.`
    );
  }
  if (delivered === null) {
    return (
      `this is not ${expected}: the document on ${baseUrl} carries no ` +
      `<meta name="${IDENTITY_META}">. Its title reads "${title}". Either a sister ` +
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
