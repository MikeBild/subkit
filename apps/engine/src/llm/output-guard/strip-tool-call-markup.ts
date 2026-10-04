const CLOSED_BLOCK_RES: RegExp[] = [
  /<(?:antml:)?function_calls>[\s\S]*?<\/(?:antml:)?function_calls>/gi,
  /<(?:antml:)?invoke\s+name=[\s\S]*?<\/(?:antml:)?invoke>/gi,
];

const DANGLING_RE = /<(?:antml:)?(?:function_calls>|invoke\s+name=)[\s\S]*$/i;

export function stripLeakedToolCallMarkup(text: string): { text: string; stripped: number } {
  if (!text.includes("<")) return { text, stripped: 0 };
  let out = text;
  let stripped = 0;
  for (const re of CLOSED_BLOCK_RES) {
    out = out.replace(re, () => {
      stripped += 1;
      return "";
    });
  }
  if (DANGLING_RE.test(out)) {
    out = out.replace(DANGLING_RE, () => {
      stripped += 1;
      return "";
    });
  }
  if (stripped > 0) {
    out = out
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\s+$/, "");
  }
  return { text: out, stripped };
}
