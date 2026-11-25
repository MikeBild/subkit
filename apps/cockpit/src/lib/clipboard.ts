export async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export async function readClipboardText(): Promise<string> {
  return await navigator.clipboard.readText();
}
