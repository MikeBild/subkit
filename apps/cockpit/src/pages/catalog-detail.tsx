import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, CheckCircle2, Pencil, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiRequest, apiText } from "@/api/client";
import { MarkdownWorkspace } from "@/components/cockpit/markdown-workspace";
import { WorkflowGallery } from "@/components/cockpit/workflow-gallery";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n-context";
import { statusLabel } from "@/lib/status-label";

type DetailResource = "workflows" | "connectors" | "knowledge" | "skills" | "files";
type RecordValue = Record<string, unknown>;

const ENDPOINTS: Record<DetailResource, string> = {
  workflows: "/v1/workflows",
  connectors: "/v1/connectors",
  knowledge: "/v1/knowledge-sources",
  skills: "/v1/skills",
  files: "/v1/files",
};

const DESCRIPTION_KEYS: Record<DetailResource, Parameters<ReturnType<typeof useI18n>["t"]>[0]> = {
  workflows: "resource.workflows.description",
  connectors: "resource.connectors.description",
  knowledge: "resource.knowledge.description",
  skills: "resource.skills.description",
  files: "resource.files.description",
};

const PERMISSIONS: Record<DetailResource, { read: string; write: string }> = {
  workflows: { read: "workflow:read", write: "workflow:write" },
  connectors: { read: "connector:read", write: "connector:write" },
  knowledge: { read: "knowledge:read", write: "knowledge:write" },
  skills: { read: "skill:read", write: "skill:write" },
  files: { read: "file:read", write: "file:write" },
};

function recordTitle(record: RecordValue | undefined): string {
  for (const key of ["name", "display_name", "title", "filename", "slug"]) {
    const value = record?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "—";
}

function visibleEntries(record: RecordValue): [string, string][] {
  return Object.entries(record)
    .filter(([key, value]) => {
      if (/(tenant|credential|secret|token|password|hash)/i.test(key)) return false;
      return ["string", "number", "boolean"].includes(typeof value) || value === null;
    })
    .slice(0, 14)
    .map(([key, value]) => [key.replaceAll("_", " "), value === null ? "—" : String(value)]);
}

function GovernanceBar({ record, canWrite }: { record: RecordValue; canWrite: boolean }) {
  const { t } = useI18n();
  const status =
    typeof record.status === "string"
      ? record.status
      : typeof record.lifecycle === "string"
        ? record.lifecycle
        : "active";
  const version = record.version ?? record.current_version;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-6 py-2 text-xs">
      <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
      <span className="font-medium">{t("detail.governance")}</span>
      <Badge variant="outline">{statusLabel(t, status)}</Badge>
      {version !== undefined && <Badge variant="secondary">v{String(version)}</Badge>}
      <span className="text-muted-foreground">
        {t(canWrite ? "detail.canEdit" : "detail.readOnly")}
      </span>
    </div>
  );
}

function Overview({ record }: { record: RecordValue }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 xl:grid-cols-3">
      {visibleEntries(record).map(([key, value]) => (
        <div key={key} className="min-w-0 bg-background p-4">
          <dt className="text-xs capitalize text-muted-foreground">{key}</dt>
          <dd className="mt-1 truncate text-sm font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WorkflowBody({
  id,
  record,
  canRun,
}: {
  id: string;
  record: RecordValue;
  canRun: boolean;
}) {
  const { t } = useI18n();
  const steps = Array.isArray(record.steps)
    ? record.steps.filter((step): step is RecordValue => Boolean(step) && typeof step === "object")
    : [];
  return (
    <Tabs defaultValue="steps">
      <TabsList>
        <TabsTrigger value="steps" data-testid="workflow-tab-dag">
          {t("detail.workflow")}
        </TabsTrigger>
        <TabsTrigger value="overview" data-testid="workflow-tab-overview">
          {t("detail.overview")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="steps" className="pt-4">
        <WorkflowGallery
          workflowId={id}
          steps={steps}
          definition={workflowDraftDefinition(record, steps)}
          canRun={canRun}
        />
      </TabsContent>
      <TabsContent value="overview" className="pt-4">
        <Overview record={record} />
      </TabsContent>
    </Tabs>
  );
}

/** The saved workflow replayed as a draft, so a test run never touches the stored version. */
function workflowDraftDefinition(
  record: RecordValue,
  steps: readonly RecordValue[],
): Record<string, unknown> {
  return {
    name: typeof record.name === "string" ? record.name : "Test run",
    ...(typeof record.slug === "string" ? { slug: record.slug } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    steps,
  };
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
    <MarkdownWorkspace
      value={body}
      onChange={setBody}
      onSave={() => save.mutate()}
      saving={save.isPending}
      dirty={body !== initial}
      readOnly={!canWrite}
      label={recordTitle(record)}
    />
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
  const document = content.data?.documents[documentIndex];
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
  if (content.isPending) return <Skeleton className="h-96 w-full" />;
  if (content.error || !document) return <Overview record={{ editable: false }} />;
  return (
    <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-xl border">
      {content.data.documents.length > 1 && (
        <div className="flex flex-wrap gap-2 border-b p-2">
          {content.data.documents.map((item, index) => (
            <Button
              key={item.path}
              size="sm"
              variant={index === documentIndex ? "secondary" : "ghost"}
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
        readOnly={!canWrite || !content.data.editable}
        label={document.path}
      />
    </div>
  );
}

function FileBody({ id, record }: { id: string; record: RecordValue }) {
  const contentType = typeof record.content_type === "string" ? record.content_type : "";
  const isText =
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("markdown");
  const content = useQuery({
    queryKey: ["file-content", id],
    queryFn: () => apiText(`/v1/files/${encodeURIComponent(id)}/content`),
    enabled: isText,
  });
  if (!isText) return <Overview record={record} />;
  if (content.isPending) return <Skeleton className="h-96 w-full" />;
  return (
    <div className="min-h-[34rem] overflow-hidden rounded-xl border">
      <MarkdownWorkspace
        value={content.data ?? ""}
        onChange={() => undefined}
        readOnly
        label={recordTitle(record)}
      />
    </div>
  );
}

function MetadataDialog({
  resource,
  id,
  record,
}: {
  resource: Exclude<DetailResource, "files">;
  id: string;
  record: RecordValue;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(recordTitle(record));
  const mutation = useMutation({
    mutationFn: () => {
      const path =
        resource === "workflows"
          ? `/v1/workflows/${encodeURIComponent(id)}/metadata`
          : `${ENDPOINTS[resource]}/${encodeURIComponent(id)}`;
      const body =
        resource === "skills" ? { title: name, expected_version: record.version } : { name };
      return apiRequest<RecordValue>(path, { method: "PATCH", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setOpen(false);
      toast.success(t("detail.saved"));
      await queryClient.invalidateQueries({ queryKey: ["catalog-detail", resource, id] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="detail-edit-metadata">
        <Pencil data-icon="inline-start" />
        {t("detail.editMetadata")}
      </Button>
      <DialogContent data-testid="detail-metadata-dialog">
        <DialogHeader>
          <DialogTitle>{t("detail.editMetadata")}</DialogTitle>
          <DialogDescription>{t("detail.editMetadataDescription")}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="detail-record-name">{t("common.name")}</FieldLabel>
          <Input
            id="detail-record-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="detail-metadata-name"
          />
        </Field>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            data-testid="detail-metadata-cancel"
          >
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!name.trim() || name === recordTitle(record) || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="detail-metadata-save"
          >
            {t("common.saveChanges")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CatalogDetailPage({
  resource,
  permissions,
}: {
  resource: DetailResource;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const access = PERMISSIONS[resource];
  const canRead = permissions.includes(access.read);
  const canWrite = permissions.includes(access.write);
  const query = useQuery({
    queryKey: ["catalog-detail", resource, id],
    queryFn: () => apiRequest<RecordValue>(`${ENDPOINTS[resource]}/${encodeURIComponent(id)}`),
    enabled: canRead && Boolean(id),
  });
  const record = query.data;
  const prompt = useMemo(
    () => encodeURIComponent(`${t("detail.continueInChat")}: ${recordTitle(record)}`),
    [record, t],
  );
  const chatTarget =
    resource === "workflows"
      ? `&workflow_id=${encodeURIComponent(id)}`
      : resource === "connectors"
        ? `&connector_id=${encodeURIComponent(id)}`
        : "";
  const probe = useMutation({
    mutationFn: () =>
      apiRequest<RecordValue>(`/v1/connectors/${encodeURIComponent(id)}/test`, { method: "POST" }),
    onSuccess: () => toast.success(t("detail.testPassed")),
  });

  if (!canRead)
    return (
      <Alert className="m-6">
        <AlertTitle>{t("resource.permission.title")}</AlertTitle>
        <AlertDescription>{t("resource.permission.description")}</AlertDescription>
      </Alert>
    );
  if (query.isPending)
    return (
      <div className="grid gap-4 p-6">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (query.error || !record)
    return (
      <Alert variant="destructive" className="m-6">
        <AlertTitle>{t("resource.loadFailed", { resource })}</AlertTitle>
        <AlertDescription>{t("resource.loadFailedDescription")}</AlertDescription>
      </Alert>
    );

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid={`detail-${resource}`}>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b p-6">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
            <a href={`/cockpit/${resource}`} data-testid="detail-back">
              <ArrowLeft data-icon="inline-start" />
              {t("detail.back")}
            </a>
          </Button>
          <h1 className="truncate text-2xl font-semibold tracking-tight">{recordTitle(record)}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t(DESCRIPTION_KEYS[resource])}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {resource !== "files" && canWrite && (
            <MetadataDialog resource={resource} id={id} record={record} />
          )}
          {resource === "connectors" && permissions.includes("connector:test") && (
            <Button
              variant="outline"
              disabled={probe.isPending}
              onClick={() => probe.mutate()}
              data-testid="connector-test"
            >
              <RefreshCw data-icon="inline-start" />
              {t("detail.test")}
            </Button>
          )}
          <Button asChild>
            <a
              href={`/cockpit/chat/new?prompt=${prompt}${chatTarget}`}
              data-testid="detail-chat-action"
            >
              <Bot data-icon="inline-start" />
              {t("detail.continueInChat")}
            </a>
          </Button>
        </div>
      </header>
      <GovernanceBar record={record} canWrite={canWrite} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 p-6">
        {resource === "workflows" ? (
          <WorkflowBody id={id} record={record} canRun={permissions.includes("workflow:run")} />
        ) : null}
        {resource === "skills" ? <SkillBody id={id} record={record} canWrite={canWrite} /> : null}
        {resource === "knowledge" ? <KnowledgeBody id={id} canWrite={canWrite} /> : null}
        {resource === "files" ? <FileBody id={id} record={record} /> : null}
        {resource === "connectors" ? <Overview record={record} /> : null}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="size-4" />
          {t("detail.workspaceScoped")}
        </div>
      </div>
    </main>
  );
}

export type { DetailResource };
