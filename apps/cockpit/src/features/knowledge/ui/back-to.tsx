import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/cockpit/patterns/controls";

export function BackTo({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      data-testid="kn-sources-back"
      variant="ghost"
      size="sm"
      className="-ml-3 self-start"
      onClick={onClick}
    >
      <ArrowLeft className="size-4" aria-hidden />
      {label}
    </Button>
  );
}
