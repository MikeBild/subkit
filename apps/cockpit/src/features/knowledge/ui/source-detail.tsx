import { IconTile } from "@ui/atoms/icon-tile";
import { cn } from "@ui/lib/utils";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useActorDirectory } from "@/app/actor-directory";
import { useSession } from "@/app/session";
import { Button } from "@/components/cockpit/patterns/controls";
import { CatalogPurpose } from "@/features/catalog";
import { loadSourceVersionText } from "@/features/knowledge/api/knowledge-source-queries";
import { failedSourceRemedy, SOURCE_TONE, sourceView } from "@/features/knowledge/model/knowledge";
import {
  sourceKind,
  sourcePrimaryAction,
} from "@/features/knowledge/model/knowledge-sources-model";
import {
  sourceStripAction,
  sourceStripText,
  sourceVersionItems,
} from "@/features/knowledge/model/source-detail-model";
import { useI18n } from "@/lib/i18n-context";
import { type KnowledgeSource, useSourceHistory } from "../hooks/use-source";
import { useSourceActions } from "../hooks/use-source-actions";
import { reviewDueAt } from "../model/review-date";
import { KEYS } from "../queries";
import {
  ConfirmDelete,
  DetailShell,
  UsageList,
  useMetadataMenu,
  useRel,
  VersionsTab,
} from "../shell";
import { useRecordUses } from "../uses";
import { AddressDialog } from "./address-dialog";
import { ReviewDateDialog } from "./review-date-dialog";
import { SourceContent } from "./source-content";
import { sourceFacts } from "./source-facts";
import { SOURCE_KIND_ICON } from "./source-kind-icon";
import { SourceMenu } from "./source-menu";
import { SourceStripAction } from "./source-strip-action";
import { TextDialog } from "./text-dialog";

export function SourceDetail({
  src,
  onBack,
  onRemoved,
}: {
  src: KnowledgeSource;
  onBack: () => void;
  onRemoved: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const rel = useRel();
  const directory = useActorDirectory(true);
  const canWrite = session.permissions.includes("knowledge:write");
  const canDelete = session.permissions.includes("knowledge:delete");
  const v = sourceView(src);
  const meta = useMetadataMenu({
    kind: "knowledge_source",
    id: src.id,
    record: src,
    queryKey: KEYS.source(src.id),
  });
  const [addr, setAddr] = useState(false);
  const [editing, setEditing] = useState(false);
  const [del, setDel] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const on = v.status !== "off";
  const { ingest, toggle, remove, restore, saved, review } = useSourceActions(src, {
    on,
    onRemoved,
  });
  const history = useSourceHistory(src.id);
  const uses = useRecordUses({
    binding: { scope: src.scope, workflowId: src.workflow_id },
    target: { kind: "knowledge", id: src.id },
  });
  const editable = v.kind === "url";
  const remedy = failedSourceRemedy(sourcePrimaryAction(sourceKind(src.source_type)), {
    write: canWrite,
    chat: session.permissions.includes("conversation:write"),
  });
  const stripAction = sourceStripAction(v.status, remedy, canWrite);
  return (
    <>
      <DetailShell
        back={t("kn.sources.title")}
        onBack={onBack}
        icon={<IconTile icon={SOURCE_KIND_ICON[v.kind]} size="lg" />}
        title={src.name}
        sub={<CatalogPurpose record={src} />}
        strip={{
          tone: SOURCE_TONE[v.status],
          text: sourceStripText(v, t, rel),
          ...(stripAction
            ? {
                action: (
                  <SourceStripAction
                    action={stripAction}
                    source={src}
                    busy={toggle.isPending}
                    onRetry={() => ingest.mutate()}
                    onActivate={() => toggle.mutate()}
                  />
                ),
              }
            : {}),
        }}
        actions={
          editable && canWrite ? (
            <Button
              data-testid="kn-sources-ingestNow"
              variant="outline"
              disabled={v.status === "ingesting" || !on || ingest.isPending}
              onClick={() => ingest.mutate()}
            >
              <RefreshCw
                className={cn("size-4", v.status === "ingesting" && "animate-spin")}
                aria-hidden
              />
              {t("kn.sources.ingestNow")}
            </Button>
          ) : undefined
        }
        menu={
          <SourceMenu
            sourceId={src.id}
            can={{ write: canWrite, delete: canDelete, address: editable, text: v.kind === "text" }}
            on={on}
            metadata={meta.items}
            onAddress={() => setAddr(true)}
            onEditText={() => setEditing(true)}
            onToggle={() => toggle.mutate()}
            onReview={() => setReviewing(true)}
            onDelete={() => setDel(true)}
          />
        }
        tabs={[
          { id: "content", label: t("kn.tab.content"), content: <SourceContent src={src} /> },
          {
            id: "usage",
            label: t("kn.tab.usage"),
            content: <UsageList uses={uses} empty={t("kn.sources.usedEverywhere")} />,
          },
          {
            id: "versions",
            label: t("kn.tab.versions"),
            content: (
              <VersionsTab
                versions={sourceVersionItems(history.data?.items ?? [], directory, t)}
                busy={restore.isPending}
                canRestore={canWrite}
                onRestore={(k) => restore.mutate(Number(k))}
                load={(k) => loadSourceVersionText(src.id, Number(k))}
              />
            ),
          },
        ]}
        facts={sourceFacts(src, v, i18n)}
      />
      {editable && <AddressDialog open={addr} onOpenChange={setAddr} src={src} onSaved={saved} />}
      {v.kind === "text" && <TextDialog open={editing} onOpenChange={setEditing} src={src} />}
      {canWrite && meta.dialog}
      {canWrite && (
        <ReviewDateDialog
          name={src.name}
          current={reviewDueAt(src)}
          open={reviewing}
          pending={review.isPending}
          onOpenChange={setReviewing}
          onSave={(at) => review.mutate(at, { onSuccess: () => setReviewing(false) })}
        />
      )}
      <ConfirmDelete
        open={del}
        onOpenChange={setDel}
        name={src.name}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
