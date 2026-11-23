import { useNavigate } from "@tanstack/react-router";
import { listPageFailure } from "@ui/lib/errors";
import { ErrorState } from "@ui/molecules/error-notice";
import { Plus } from "lucide-react";
import { useState } from "react";
import { recordHref } from "@/app/links";
import { useSession } from "@/app/session";
import { Button } from "@/components/cockpit/patterns/controls";
import { TopPageHeader } from "@/components/cockpit/patterns/page-header";
import { usePageFailure } from "@/components/cockpit/patterns/use-error-detail";
import type { AddMode } from "@/features/knowledge/model/add-source-model";
import { SOURCE_PROMPTS } from "@/features/knowledge/model/source-list-model";
import { useI18n } from "@/lib/i18n-context";
import { useSource } from "./hooks/use-source";
import { useSourceColumns } from "./hooks/use-source-columns";
import { useSourceList } from "./hooks/use-source-list";
import { ChatMenu, ListSkeleton, Loaded, useListState, usePageMenu } from "./shell";
import { AddSourceDialog } from "./ui/add-source-dialog";
import { SourceDetail } from "./ui/source-detail";
import { SourcesList } from "./ui/sources-list";
import { SourcesOnboarding } from "./ui/sources-onboarding";

export function SourcesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const session = useSession();
  const canWrite = session.permissions.includes("knowledge:write");
  const st = useListState();
  const menu = usePageMenu({ pkg: "knowledge", categories: "knowledge_source", category: st.cat });
  const [adding, setAdding] = useState<AddMode | null>(null);
  const [starter, setStarter] = useState("");
  const { query, views, items, groups, sections } = useSourceList(st);
  const { head, columns } = useSourceColumns();
  const open = (id: string) => void navigate({ to: recordHref("knowledge", id) });
  const add = (mode: AddMode, name = "") => {
    setStarter(name);
    setAdding(mode);
  };
  const failure = usePageFailure(
    listPageFailure({
      failed: query.isError,
      loaded: query.data !== undefined,
      onRetry: () => void query.refetch(),
      error: query.error,
      collectionId: "kn",
    }),
  );
  if (failure) return <ErrorState {...failure} heading="h1" />;
  return (
    <div>
      <TopPageHeader
        title={t("nav.knowledgeSources")}
        help={t("kn.sources.help")}
        action={
          <div className="flex items-center gap-2">
            <ChatMenu items={menu.items} prompts={SOURCE_PROMPTS.map((k) => t(k))} />
            {canWrite && (
              <Button data-testid="kn-sources-add" onClick={() => add("url")}>
                <Plus className="size-4" aria-hidden />
                {t("kn.sources.add")}
              </Button>
            )}
          </div>
        }
      />
      {query.data && views.length === 0 && (
        <SourcesOnboarding
          canWrite={canWrite}
          onAdd={add}
          onInbox={() => void navigate({ to: "/intake" })}
        />
      )}
      <Loaded query={query}>
        {() => (
          <SourcesList
            st={st}
            head={head}
            columns={columns}
            views={views}
            items={items}
            groups={groups}
            sections={sections}
            onOpen={open}
          />
        )}
      </Loaded>
      {canWrite && (
        <AddSourceDialog
          open={adding !== null}
          initialMode={adding ?? "url"}
          initialName={starter}
          onOpenChange={(v) => !v && setAdding(null)}
          onCreated={(source) => open(source.id)}
        />
      )}
      {menu.dialogs}
    </div>
  );
}

export function SourcePage({ id }: { id: string }) {
  const navigate = useNavigate();
  const query = useSource(id);
  const home = () => void navigate({ to: "/knowledge" });
  if (!query.data && !query.isError) return <ListSkeleton />;
  return (
    <Loaded query={query}>
      {(src) => <SourceDetail key={src.id} src={src} onBack={home} onRemoved={home} />}
    </Loaded>
  );
}
