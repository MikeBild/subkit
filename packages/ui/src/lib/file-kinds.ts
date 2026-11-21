export type FileKind = "image" | "pdf" | "csv" | "md" | "text";

export const extOf = (name: string) =>
  name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";

export function fileKindOf(name: string): FileKind {
  const e = extOf(name);
  return ["png", "jpg", "jpeg", "gif", "webp"].includes(e)
    ? "image"
    : e === "pdf"
      ? "pdf"
      : e === "csv"
        ? "csv"
        : e === "md"
          ? "md"
          : "text";
}
