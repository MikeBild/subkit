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
 * THE BOUNDARY MOVED, and it is worth naming: the reader used to sit on the
 * DELIVERED BYTES and now sits on the RENDERED DOM. That is not a strictly
 * sharper reader, it is a different one, and it loses a case the byte reader
 * won — a document whose text stamps WorkKit and whose inline script rewrites
 * the marker to SubKit on load reads as WorkKit in the bytes and as SubKit
 * here. Taken deliberately: the DOM is what gets photographed. A frame shows
 * the rendered document, so the name on the frame has to come from the same
 * place the picture does. Bytes nobody can see are not what a screenshot is
 * about.
 *
 * ONE DOOR, and it is `standAt().visit()`.
 *
 * Asking once was still not asking. The reader was the camera and the question
 * was put to a page of its own, before the first frame — `browser.newPage()` on
 * `/cockpit/`, while every frame came from a `browser.newContext()` of its own
 * on `/cockpit/<route>`. One browser, but neither the same page nor the same
 * document. Measured against a stand that changes hands after its first answer:
 * 1 SubKit answer (the identity question) against 240 WorkKit answers (every
 * document photographed), exit 0, 296 frames. Identity is a property of a stand
 * OVER TIME, not a one-off answer to one URL.
 *
 * So navigation and identity are one act. `visit()` is a door, not a reader:
 * nothing here hands out a page without first going through what names it, and
 * a run that never got a name has no name to write a file under — see
 * `frameName`. The price is one `page.evaluate` per navigation, and it is the
 * right price.
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
    // The same rule one attribute to the right, and it was missing for three
    // rounds while the paragraph above claimed to cover it. Chromium decodes a
    // character reference in the attribute VALUE exactly as it does in the
    // name: `content="Work&#75;it"` is `WorkKit` to the parser and stays
    // `Work&#75;it` here. It fell LOUD rather than quiet — the expected value is
    // read from our own file, so the two disagree and every caller exits — but a
    // rule this file states about itself and does not keep is not a rule.
    if (contents[0].includes("&")) return null;
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
      `measured and photographed under the name ${expected}.`
    );
  }
  if (delivered !== expected) {
    return (
      `this is not ${expected} but ${delivered}: the document on ${baseUrl} calls itself ` +
      `"${delivered}", apps/cockpit/index.html names "${expected}". Nothing here is a statement ` +
      `about ${expected}.`
    );
  }
  return null;
}

/**
 * A name a file may be written under: a plain word, nothing that is also a path.
 *
 * The product name comes out of a served document and is then part of a file
 * path. It can only ever be the value this repository's own index.html carries
 * — `identityProblem` refuses everything else — but a string that reaches a
 * path must be checked where it reaches it, not where it is believed to be
 * harmless.
 */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * THE DOOR: a stand, and the only way to a page on it.
 *
 * `visit()` navigates AND names, in one act, on the page that is about to be
 * used. There is deliberately no way to do one without the other — asking once
 * before the first frame is what produced 296 pictures of a console that
 * changed hands after answering the question.
 *
 * `refuse(sentence, options)` builds the caller's own error type: the visual
 * sweep needs "NOT TAKEN" and exit 1, the convention check needs `NichtGemessen`
 * and exit 2. The sentences themselves are composed here so both callers say
 * the same things about the same situations.
 *
 * The gate is a BARRIER, not a race leg. Nothing observes the stand alongside
 * the run and interrupts it; the run cannot proceed except through the gate.
 * That distinction is the property worth copying from the sibling that got here
 * first — its identity gate is a barrier and its harness-death gate is a race,
 * and only the first of the two can promise anything.
 */
export function standAt({ baseUrl, refuse, hint = "" }) {
  // Read once per run, not per navigation: this is OUR file, and the question
  // being asked 300 times is about the stand, not about the repository.
  const expected = expectedIdentity();
  /** Which product answered on which page — set only by a navigation that named it. */
  const named = new WeakMap();
  /** The identity of the LAST answer. Never an earlier one; see `visit`. */
  let identity = null;
  const tail = hint ? ` ${hint}` : "";

  return {
    baseUrl,
    expected,
    /**
     * Whose console answered LAST — for reports, never for an assert.
     *
     * A stand that has changed hands has no confirmed identity any more.
     * Printing the first answer above an abort that named a different product
     * is one report saying two different things.
     */
    get identity() {
      return identity;
    },

    /**
     * Go to a page of this stand — and get one only if the stand names itself.
     *
     * @param page   a Playwright page; it is the reader AND the camera.
     * @param path   the part after `/cockpit/`; `""` is the shell.
     * @returns the navigation response, for callers that check more than status.
     */
    async visit(page, path, options = { waitUntil: "networkidle" }) {
      const url = `${baseUrl}/cockpit/${path}`;
      // Withdrawn before the question, restored only by an answer. Every path
      // out of here that is not the last line leaves this page unnamed.
      named.delete(page);
      identity = null;
      let response;
      try {
        response = await page.goto(url, options);
      } catch (error) {
        throw refuse(`nothing answers on ${url}: ${error.message}.${tail}`, { cause: error });
      }
      if (!response?.ok()) throw refuse(`${url} answered with HTTP ${response?.status()}.${tail}`);
      const { marker, title } = await readIdentity(page);
      const problem = identityProblem({ delivered: marker, title, expected, baseUrl });
      if (problem !== null) throw refuse(problem);
      named.set(page, marker);
      identity = marker;
      return response;
    },

    /**
     * The file name a frame of THIS page may be written under.
     *
     * CONSTRUCTIVE, and that is the whole point: the name is built from the
     * product that ANSWERED on this page, so an unauthorised run has no name to
     * write under — no path comes into existence and `screenshot` is never
     * called. A guard one can forget to call is a guard one forgets; this one
     * cannot be forgotten, because without it there is no path.
     */
    frameName(page, label) {
      const product = named.get(page);
      if (product === undefined)
        throw refuse(
          `no frame of an unnamed page (${label}): this page never went through visit(), so ` +
            "nothing has said whose console it shows and there is no name to write the file under.",
        );
      if (!PLAIN_NAME.test(product))
        throw refuse(`"${product}" is not a name a file can be written under (${label}).`);
      return `${product.toLowerCase()}-${label}.png`;
    },

    /**
     * The name of an artifact assembled from frames this stand already named.
     *
     * A contact sheet has no document of its own — it is built with
     * `setContent` out of files that are already on disk. It still gets its name
     * from an answer: `identity` is null until a visit succeeds and null again
     * the moment one fails, so a run that never passed the gate cannot name this
     * either.
     */
    sheetName(label) {
      if (identity === null)
        throw refuse(
          `no contact sheet without a named stand (${label}): nothing on ${baseUrl} has confirmed ` +
            "whose console these frames are of.",
        );
      return `${identity.toLowerCase()}-${label}.png`;
    },
  };
}
