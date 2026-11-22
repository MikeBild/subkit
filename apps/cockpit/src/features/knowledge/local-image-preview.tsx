import { type ReactNode, useEffect, useRef, useState } from "react";

export function LocalImagePreview({ file, fallback }: { file: File; fallback: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let bitmap: ImageBitmap | null = null;
    setFailed(false);
    createImageBitmap(file)
      .then((decoded) => {
        bitmap = decoded;
        const target = canvas.current;
        if (!live || !target) return;
        target.width = decoded.width;
        target.height = decoded.height;
        target.getContext("2d")?.drawImage(decoded, 0, 0);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
      bitmap?.close();
    };
  }, [file]);
  if (failed) return fallback;
  return (
    <canvas
      ref={canvas}
      data-testid="kn-up-preview"
      role="img"
      aria-label={file.name}
      className="h-auto w-full rounded-lg border bg-background"
    />
  );
}
