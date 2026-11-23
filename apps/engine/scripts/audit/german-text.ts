export const GERMAN_TEXT_HOMES: readonly RegExp[] = [
  /^apps\/cockpit\/src\/lib\/i18n\//,
  /^apps\/desktop\/src\/shared\/i18n\.ts$/,
  /^packages\/ui\/src\/i18n\//,
  /^packages\/shared\/src\/error-catalog\.ts$/,
  /^apps\/engine\/src\/http\/i18n\//,
  /^apps\/engine\/src\/http\/i18n\//,
  /^apps\/engine\/src\/http\/reference\/[^/]+\.de\.md$/,
  /^apps\/engine\/src\/http\/llms\//,
  /^(vendor|patches)\//,
  /^apps\/engine\/scripts\/(audit\/german-text|__tests__\/german-text\.test)\.ts$/,
];

const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|json|md|html|css|yml|yaml|sh|txt|toml)$/;
const LOCKFILE = /(^|\/)(bun\.lock|package-lock\.json)$/;

const GERMAN_CHARACTER = /[äöüÄÖÜß„]/;
const GERMAN_WORD =
  /(?<![\p{L}\p{N}_])(und|nicht|bitte|Fehler|wird|werden|oder|keine|kein|sind|auch|noch|dein|deine|deinen|deinem|deiner)(?![\p{L}\p{N}_])/u;

export function isGermanTextScope(path: string): boolean {
  return (
    TEXT_FILE.test(path) &&
    !LOCKFILE.test(path) &&
    !GERMAN_TEXT_HOMES.some((home) => home.test(path))
  );
}

export function germanTextLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (GERMAN_CHARACTER.test(line) || GERMAN_WORD.test(line)) lines.push(index + 1);
  });
  return lines;
}
