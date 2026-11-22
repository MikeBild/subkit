export const TYPED_VERSION_SCOPE =
  /^(README\.md|apps\/engine\/src\/http\/reference\/[^/]+\.(de|en)\.md|apps\/clipper\/public\/[^/]+\.(json|html))$/;

const VERSION = /(?<![\w./@#])v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z]+(?:\.\d+)?)?(?![\w]|\.\d)/g;

const HISTORY_START = "<!-- release-history -->";
const HISTORY_END = "<!-- /release-history -->";

export interface TypedVersionHit {
  line: number;
  version: string;
}

function isGroupedNumber(major: string, minor: string, patch: string): boolean {
  return major.length <= 3 && minor.length === 3 && patch.length === 3;
}

export function findTypedVersions(text: string): TypedVersionHit[] {
  const hits: TypedVersionHit[] = [];
  let historyStart = 0;
  text.split("\n").forEach((content, index) => {
    const trimmed = content.trim();
    if (trimmed === HISTORY_START) historyStart = index + 1;
    if (trimmed === HISTORY_END) {
      historyStart = 0;
      return;
    }
    if (historyStart > 0) return;
    for (const match of content.matchAll(VERSION)) {
      const [version, major = "", minor = "", patch = ""] = match;
      if (isGroupedNumber(major, minor, patch)) continue;
      hits.push({ line: index + 1, version });
    }
  });
  if (historyStart > 0) hits.push({ line: historyStart, version: "unclosed release history" });
  return hits;
}
