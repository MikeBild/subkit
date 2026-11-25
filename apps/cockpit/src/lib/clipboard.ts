/** The one place the Cockpit touches `navigator.clipboard`. Both reject when access is denied. */
export async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export async function readClipboardText(): Promise<string> {
  return await navigator.clipboard.readText();
}
