declare const BUILD_VERSION: string;
export const VERSION: string = typeof BUILD_VERSION !== "undefined" ? BUILD_VERSION : "0.0.0-dev";
