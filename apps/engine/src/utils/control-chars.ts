export type CodePredicate = (code: number) => boolean;

const TAB = 0x09;
const DELETE = 0x7f;

export const isC0: CodePredicate = (code) => code <= 0x1f;
export const isC0OrDelete: CodePredicate = (code) => isC0(code) || code === DELETE;
export const isC0OrDeleteExceptTab: CodePredicate = (code) => code !== TAB && isC0OrDelete(code);

export function hasCode(text: string, predicate: CodePredicate): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (predicate(text.charCodeAt(i))) return true;
  }
  return false;
}

export function withoutCodes(text: string, predicate: CodePredicate): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (!predicate(text.charCodeAt(i))) out += text[i];
  }
  return out;
}
