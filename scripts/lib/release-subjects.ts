export const ENGLISH_SUBJECTS: Readonly<Record<string, string>> = {
  "17ffd8a678410c5f4dde1221dcc2dc2958fe178c":
    "fix(user): safe knowledge import and reliable AI checks",
  d58b421953d4a4486b9a4ced328d2fa0081315c4:
    "fix(user): delete discarded inbox entries and show approvals clearly",
  "5ac3a5e6d784e66d90def895338fbe860c8568ce": "fix(user): mark held runs clearly everywhere",
  e0675ed0d26cbd2cb856ed800e507e91c23800dc: "fix(user): leave held runs out of success rates",
};

export function englishSubject(hash: string, subject: string): string {
  return ENGLISH_SUBJECTS[hash] ?? subject;
}
