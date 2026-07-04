// Platform adapter — the surface the chat UI calls out to for
// anything platform-specific (clipboard, filesystem, external
// editor, native image paste). The host CLI (`sk` or `subkit chat`)
// supplies an implementation at mount time; all components within
// `chat-ui` reach through the `Platform` context rather than
// importing `child_process` or `fs` directly.
//
// Keeping this abstraction lets `chat-ui` stay framework-pure — it
// knows about Ink and React, not about whether the host runtime is
// Bun, Node, or Deno.

export interface Platform {
  /** Copy text to the system clipboard (OSC 52 fallback for SSH). */
  copyToClipboard(text: string): Promise<void>;
  /** Read an image from the clipboard; returns null if unsupported. */
  readClipboardImage(): Promise<PlatformImage | null>;
  /** Resolve a file path into an image payload (for drag-dropped files). */
  readImageFromPath(path: string): Promise<PlatformImage | null>;
  /** Open the external editor on the given buffer; returns the edited text. */
  openEditor(initialText: string): Promise<string>;
  /** Ring the terminal bell (`\x07`). No-op if stdout is not a TTY. */
  bell(): void;
  /** Write a line to the host's log sink. */
  log(level: "info" | "warn" | "error", msg: string): void;
}

export interface PlatformImage {
  /** Raw binary data. */
  data: Uint8Array;
  /** IANA media type (`image/png`, `image/jpeg`, …). */
  mediaType: string;
  /** Original filename if known. */
  filename?: string;
  /** Width / height if known. */
  width?: number;
  height?: number;
}
