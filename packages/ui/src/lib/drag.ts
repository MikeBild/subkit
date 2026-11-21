import type { DragEvent as ReactDragEvent } from "react";

export const hasFiles = (e: ReactDragEvent | DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");
