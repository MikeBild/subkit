export interface Platform {
  copyToClipboard(text: string): Promise<void>;
  readClipboardImage(): Promise<PlatformImage | null>;
  readImageFromPath(path: string): Promise<PlatformImage | null>;
  openEditor(initialText: string): Promise<string>;
  bell(): void;
  log(level: "info" | "warn" | "error", msg: string): void;
}

export interface PlatformImage {
  data: Uint8Array;
  mediaType: string;
  filename?: string;
  width?: number;
  height?: number;
}
