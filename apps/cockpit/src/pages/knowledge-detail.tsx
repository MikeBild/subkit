import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { apiRequest, apiText } from "@/api/client";
import { DetailAction } from "@/components/cockpit/detail-action";
import { MarkdownWorkspace } from "@/components/cockpit/markdown-workspace";
import { MetadataDialog } from "@/components/cockpit/metadata-dialog";
import {
  ActionMenu,
  Button,
  CollapsibleSection,
  DataState,
  type Fact,
  FactList,
  Page,
  PageHeader,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { bytes, MISSING } from "@/components/cockpit/table-columns";
import { queryView } from "@/components/failure-state";
import {
  type DetailEntry,
  detailEntries,
  recordBarFacts,
  SCOPE_KEYS,
  SIDE_EFFECT_KEYS,
} from "@/lib/detail-fields";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";
import { type RecordValue, recordPurpose, recordTitle } from "@/pages/catalog-model";

/** The records Wissen holds: sources, skills and files — each one document. */
export type KnowledgeResource = "knowledge" | "skills" | "files";

const ENDPOINTS: Record<KnowledgeResource, string> = {
  knowledge: "/v1/knowledge-sources",
  skills: "/v1/skills",
  files: "/v1/files",
};

const PERMISSIONS: Record<KnowledgeResource, { read: string; write: string }> = {
  knowledge: { read: "knowledge:read", write: "knowledge:write" },
  skills: { read: "skill:read", write: "skill:write" },
  files: { read: "file:read", write: "file:write" },
};

export function isKnowledgeResource(resource: string): resource is KnowledgeResource {
  return resource in ENDPOINTS;
}

/**
 * One curated field as the reader sees it, through the same helpers the list
 * cells use — a state word, a byte count, a timestamp in the locale's form.
 */
function detailValue(
  entry: DetailEntry,
  t: ReturnType<typeof useI18n>["t"],
  dateTime: ReturnType<typeof useI18n>["dateTime"],
): string {
  const { value, format } = entry;
  if (value === null || value === undefined || value === "") return MISSING;
  switch (format) {
    case "date":
      return typeof value === "string" ? dateTime(value) : MISSING;
    case "boolean":
      return t(value === true ? "common.yes" : "common.no");
    case "status":
      return typeof value === "string" ? statusLabel(t, value) : MISSING;
    case "bytes":
      return bytes(value);
    case "scope": {
      const key = typeof value === "string" ? SCOPE_KEYS[value] : undefined;
      return key ? t(key) : String(value);
    }
    case "sideEffects": {
      const key = typeof value === "string" ? SIDE_EFFECT_KEYS[value] : undefined;
      return key ? t(key) : String(value);
    }
    case "maturity":
      return t(
        value === "experimental" ? "catalog.maturity.experimental" : "catalog.maturity.stable",
      );
    default:
      return String(value);
  }
}

function SkillBody({
  id,
  record,
  canWrite,
}: {
  id: string;
  record: RecordValue;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const initial = typeof record.body === "string" ? record.body : "";
  const [body, setBody] = useState(initial);
  useEffect(() => setBody(initial), [initial]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest<RecordValue>(`/v1/skills/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ body, expected_version: record.version }),
      }),
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["catalog-detail", "skills", id] });
    },
  });
  return (
    <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-lg border">
      <MarkdownWorkspace
        value={body}
        onChange={setBody}
        onSave={() => save.mutate()}
        saving={save.isPending}
        dirty={body !== initial}
        readOnly={!canWrite}
        label={recordTitle(record)}
      />
    </div>
  );
}

interface KnowledgeContent {
  knowledge_source_id: string;
  version: string;
  editable: boolean;
  documents: { path: string; content: string }[];
}

function KnowledgeBody({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const content = useQuery({
    queryKey: ["knowledge-content", id],
    queryFn: () =>
      apiRequest<KnowledgeContent>(`/v1/knowledge-sources/${encodeURIComponent(id)}/content`),
  });
  const [documentIndex, setDocumentIndex] = useState(0);
  // An answer without a `documents` array is a failure to render, not a throw
  // that takes the whole cockpit with it.
  const documents = Array.isArray(content.data?.documents) ? content.data.documents : [];
  const document = documents[documentIndex];
  const [value, setValue] = useState("");
  useEffect(() => setValue(document?.content ?? ""), [document]);
  const save = useMutation({
    mutationFn: () =>
      apiRequest<KnowledgeContent>(`/v1/knowledge-sources/${encodeURIComponent(id)}/content`, {
        method: "PUT",
        body: JSON.stringify({
          expected_version: content.data?.version,
          path: document?.path,
          content: value,
        }),
      }),
    onSuccess: async () => {
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["knowledge-content", id] });
    },
  });
  if (content.isPending) return <DataState state="loading" />;
  // A source that could not be read is an error with a way out; a source that
  // carries no document yet is an empty state and says so.
  if (content.error)
    return (
      <DataState
        state="error"
        line={t("knowledge.contentFailed")}
        onRetry={() => void content.refetch()}
        testId="knowledge-load-failed"
      />
    );
  if (!document)
    return <DataState state="empty" line={t("knowledge.noDocuments")} testId="knowledge-empty" />;
  return (
    <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-lg border">
      {documents.length > 1 && (
        <div className="flex flex-wrap gap-2 border-b p-2">
          {documents.map((item, index) => (
            <Button
              key={item.path}
              size="sm"
              variant={index === documentIndex ? "secondary" : "ghost"}
              aria-pressed={index === documentIndex}
              onClick={() => setDocumentIndex(index)}
              data-testid={`knowledge-document-${index}`}
            >
              {item.path}
            </Button>
          ))}
        </div>
      )}
      <MarkdownWorkspace
        value={value}
        onChange={setValue}
        onSave={() => save.mutate()}
        saving={save.isPending}
        dirty={value !== document.content}
        readOnly={!canWrite || content.data?.editable !== true}
        label={document.path}
      />
    </div>
  );
}

/** A text file reads as a document; any other file has only its facts. */
function isTextFile(record: RecordValue): boolean {
  const contentType = typeof record.content_type === "string" ? record.content_type : "";
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("markdown")
  );
}

function FileBody({ id, record }: { id: string; record: RecordValue }) {
  const content = useQuery({
    queryKey: ["file-content", id],
    queryFn: () => apiText(`/v1/files/${encodeURIComponent(id)}/content`),
  });
  if (content.isPending) return <DataState state="loading" />;
  return (
    <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-lg border">
      <MarkdownWorkspace
        value={content.data ?? ""}
        onChange={() => undefined}
        readOnly
        label={recordTitle(record)}
      />
    </div>
  );
}

/**
 * A record of Wissen (V7d): the way back to its tab, its name and state, the
 * document itself, and the curated facts collapsed under "Technische
 * Angaben". Structure changes in the chat ("Im Chat ändern"); the one direct
 * edit is the name, in the menu.
 */
export function KnowledgeDetailPage({
  resource,
  permissions,
}: {
  resource: KnowledgeResource;
  permissions: readonly string[];
}) {
  const { t, dateTime } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const access = PERMISSIONS[resource];
  const canRead = permissions.includes(access.read);
  const canWrite = permissions.includes(access.write);
  const [renaming, setRenaming] = useState(false);
  const query = useQuery({
    queryKey: ["catalog-detail", resource, id],
    queryFn: () => apiRequest<RecordValue>(`${ENDPOINTS[resource]}/${encodeURIComponent(id)}`),
    enabled: canRead && Boolean(id),
  });
  const record = query.data;
  // Sources, skills and files are the tabs of one page: the way back is Wissen,
  // landing on this record's own tab.
  const back = { to: `/${resource}`, label: t("nav.knowledge") };
  const frame = (title: string, body: ReactNode) => (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      testId={`detail-${resource}`}
      header={<PageHeader back={back} title={title} />}
    >
      {body}
    </Page>
  );

  if (!canRead)
    return frame(
      MISSING,
      <DataState
        state="empty"
        line={t("resource.permission.description")}
        testId="resource-permission-alert"
      />,
    );
  // A 200 that carries no object is a failed read, the same as a 500.
  const view = queryView(query, () => false);
  if (view === "loading") return frame(MISSING, <DataState state="loading" />);
  if (view === "error" || !record)
    return frame(
      MISSING,
      <DataState
        state="error"
        line={t("detail.loadFailed")}
        onRetry={() => void query.refetch()}
        testId="detail-load-failed"
      />,
    );

  const title = recordTitle(record);
  const { status } = recordBarFacts(record);
  const facts: Fact[] = detailEntries(record).map((entry) => ({
    label: t(entry.labelKey),
    value: detailValue(entry, t, dateTime),
  }));
  const body =
    resource === "skills" ? (
      <SkillBody id={id} record={record} canWrite={canWrite} />
    ) : resource === "knowledge" ? (
      <KnowledgeBody id={id} canWrite={canWrite} />
    ) : isTextFile(record) ? (
      <FileBody id={id} record={record} />
    ) : null;
  // A file has no name of its own to change: it keeps the one it was stored under.
  const renamable = resource !== "files" && canWrite;

  return (
    <Page
      kind="detail"
      surface="detail"
      scroll="page"
      testId={`detail-${resource}`}
      header={
        <PageHeader
          back={back}
          title={title}
          badge={status ? <StatusBadge state={status} testId="detail-record-status" /> : null}
          // The record's OWN description, when it has one — never a catalogue
          // sentence that would be the same on every record.
          purpose={recordPurpose(record) || undefined}
          secondary={
            resource === "files" ? null : (
              <DetailAction resource={resource} name={title} permissions={permissions} />
            )
          }
          menu={
            renamable ? (
              <ActionMenu
                testId="detail-menu"
                items={[
                  {
                    label: t("detail.editMetadata"),
                    onSelect: () => setRenaming(true),
                    testId: "detail-edit-metadata",
                  },
                ]}
              />
            ) : null
          }
        />
      }
    >
      <div className="flex flex-col gap-8">
        {body}
        {facts.length > 0 ? (
          // Without a document the facts are all there is, so they stand open.
          <CollapsibleSection
            label={t("knowledge.technical")}
            defaultOpen={body === null}
            testId="detail-overview"
          >
            <FactList items={facts} />
          </CollapsibleSection>
        ) : null}
      </div>
      {renamable ? (
        <MetadataDialog
          resource={resource}
          id={id}
          title={title}
          version={record.version}
          open={renaming}
          onOpenChange={setRenaming}
        />
      ) : null}
    </Page>
  );
}
