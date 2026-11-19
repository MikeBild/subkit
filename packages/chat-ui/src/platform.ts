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

export function terminalSize(stream: NodeJS.WritableStream | undefined): {
  columns: number | undefined;
  rows: number | undefined;
} {
  const tty = stream as Partial<Pick<NodeJS.WriteStream, "columns" | "rows">> | undefined;
  return { columns: tty?.columns, rows: tty?.rows };
}
