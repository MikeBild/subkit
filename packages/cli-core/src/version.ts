// Build-time injected version constant.
// `bun build --define 'BUILD_VERSION="x.y.z"'` replaces the identifier at compile time.
// Falls back to "0.0.0-dev" for local development (`bun run` without --compile).
declare const BUILD_VERSION: string;
export const VERSION: string = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "0.0.0-dev";
