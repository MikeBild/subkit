import { DropdownMenuItem } from "@ui/molecules/dropdown-menu";
import { Link2, Pencil, Power, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { ChatMenu } from "../shell";

export function SourceMenu({
  sourceId,
  can,
  on,
  metadata,
  onAddress,
  onEditText,
  onToggle,
  onDelete,
}: {
  sourceId: string;
  can: { write: boolean; delete: boolean; address: boolean; text: boolean };
  on: boolean;
  metadata: ReactNode;
  onAddress: () => void;
  onEditText: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <ChatMenu
      label={t("kn.detailMenu")}
      references={[{ type: "knowledge_source", id: sourceId }]}
      prompts={[t("kn.editInChat"), t("kn.sources.prompt.ask")]}
      extra={
        can.write || can.delete ? (
          <>
            {can.write && metadata}
            {can.write && can.address && (
              <DropdownMenuItem data-testid="kn-sources-addressSchedule" onSelect={onAddress}>
                <Link2 className="size-4" aria-hidden />
                {t("kn.sources.addressSchedule")}
              </DropdownMenuItem>
            )}
            {can.write && can.text && (
              <DropdownMenuItem data-testid="kn-sources-editText" onSelect={onEditText}>
                <Pencil className="size-4" aria-hidden />
                {t("kn.sources.editText")}
              </DropdownMenuItem>
            )}
            {can.write && (
              <DropdownMenuItem data-testid="kn-sources-toggle" onSelect={onToggle}>
                <Power className="size-4" aria-hidden />
                {t(on ? "kn.turnOff" : "kn.turnOn")}
              </DropdownMenuItem>
            )}
            {can.delete && (
              <DropdownMenuItem
                data-testid="kn-sources-delete"
                className="text-destructive-ink"
                onSelect={onDelete}
              >
                <Trash2 className="size-4" aria-hidden />
                {t("kn.delete")}
              </DropdownMenuItem>
            )}
          </>
        ) : undefined
      }
    />
  );
}
