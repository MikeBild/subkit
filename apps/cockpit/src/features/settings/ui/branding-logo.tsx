import { Workflow } from "lucide-react";
import { useState } from "react";

export function BrandingLogo({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <Workflow data-icon="inline-start" />;
  return (
    <img
      src={src}
      alt=""
      className="size-full min-h-0 min-w-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
}
