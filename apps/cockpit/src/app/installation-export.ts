interface SaveTarget {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

export type InstallationSavePicker = (options: { suggestedName: string }) => Promise<SaveTarget>;

function browserSavePicker(): InstallationSavePicker | null {
  if (typeof window === "undefined" || !window.isSecureContext) return null;
  const picker = (window as Window & { showSaveFilePicker?: InstallationSavePicker })
    .showSaveFilePicker;
  return picker ? picker.bind(window) : null;
}

export async function exportInstallationFile(
  filename: string,
  read: () => Promise<Response>,
  picker: InstallationSavePicker | null = browserSavePicker(),
): Promise<"saved" | "cancelled" | "unsupported"> {
  if (!picker) return "unsupported";
  let target: SaveTarget;
  try {
    target = await picker({ suggestedName: filename.replace(/[/\\]/g, "_") });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw error;
  }
  const response = await read();
  if (!response.ok || !response.body) throw new Error("file_download_failed");
  const destination = await target.createWritable();
  await response.body.pipeTo(destination);
  return "saved";
}
