import { readFileSync } from "node:fs";

export const IDENTITY_META = "cockpit-product";

export const IDENTITY_SOURCE = new URL("../../apps/cockpit/index.html", import.meta.url);

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

export function markerIn(html) {
  const body = withoutComments(html);
  if (body === null) return null;
  const found = [];
  for (const [, attributes] of body.matchAll(/<meta\b([^>]*)>/gi)) {
    const names = [...attributes.matchAll(/\bname\s*=\s*"([^"]*)"/gi)].map(([, value]) => value);
    if (names.some((name) => name.includes("&"))) return null;
    if (/\bname\s*=/i.test(attributes) && names.length === 0) return null;
    if (!names.includes(IDENTITY_META)) continue;
    if (names.length > 1) return null;
    const contents = [...attributes.matchAll(/\bcontent\s*=\s*"([^"]*)"/gi)].map(
      ([, value]) => value,
    );
    if (contents.length !== 1) return null;
    if (contents[0].includes("&")) return null;
    found.push(contents[0]);
  }
  if (found.length !== 1) return null;
  return found[0] || null;
}

export function expectedIdentity(source = IDENTITY_SOURCE) {
  return markerIn(readFileSync(source, "utf8"));
}

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

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function standAt({ baseUrl, refuse, hint = "" }) {
  const expected = expectedIdentity();
  const named = new WeakMap();
  let identity = null;
  const tail = hint ? ` ${hint}` : "";

  return {
    baseUrl,
    expected,
    get identity() {
      return identity;
    },

    async visit(page, path, options = { waitUntil: "networkidle" }) {
      const url = path.startsWith("?") ? `${baseUrl}/cockpit${path}` : `${baseUrl}/cockpit/${path}`;
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
