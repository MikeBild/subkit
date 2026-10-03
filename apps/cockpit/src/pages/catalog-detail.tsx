import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiRequest } from "@/api/client";
import { navigationItem } from "@/app/navigation";
import { ConnectorPage } from "@/components/cockpit/connector-page";
import { BackLink, DataState, Skeleton } from "@/components/cockpit/patterns";
import { WorkflowPage } from "@/components/cockpit/workflow-page";
import { LoadFailed, queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { type RecordValue, recordPurpose, recordTitle } from "@/pages/catalog-model";
import { returnedFromSignIn, withoutSignInReturn } from "@/pages/connector-detail-model";

/** The records this page builds; Wissen's records have pages of their own. */
type DetailResource = "workflows" | "connectors";

const ENDPOINTS: Record<DetailResource, string> = {
  workflows: "/v1/workflows",
  connectors: "/v1/connectors",
};

const PERMISSIONS: Record<DetailResource, { read: string; write: string }> = {
  workflows: { read: "workflow:read", write: "workflow:write" },
  connectors: { read: "connector:read", write: "connector:write" },
};

/**
 * A record's page: a workflow (V4) or a connector (V6), each a page of its
 * own. Sources, skills and files have pages of their own too. This reads the
 * record and says when it cannot.
 */
export function CatalogDetailPage({
  resource,
  permissions,
}: {
  resource: DetailResource;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) ?? "");
  // The engine's sign-in callback sends the browser back here with a flag.
  // Read it once and drop it from the address, so a reload does not repeat
  // the sentence. The return is a full page load: connector, credential and
  // runtime are all read fresh, and what the page then says comes from them.
  const [returned] = useState(
    () => resource === "connectors" && returnedFromSignIn(window.location.search),
  );
  useEffect(() => {
    if (!returned) return;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${withoutSignInReturn(window.location.search)}${window.location.hash}`,
    );
  }, [returned]);
  const canRead = permissions.includes(PERMISSIONS[resource].read);
  const query = useQuery({
    queryKey: ["catalog-detail", resource, id],
    queryFn: () => apiRequest<RecordValue>(`${ENDPOINTS[resource]}/${encodeURIComponent(id)}`),
    enabled: canRead && Boolean(id),
  });
  const record = query.data;
  const list = navigationItem(`/${resource}`);
  const back = { to: `/${resource}`, label: list ? t(list.labelKey) : t(`nav.${resource}`) };

  if (!canRead)
    return (
      <div className="p-6">
        <DataState
          state="empty"
          line={t("resource.permission.description")}
          testId="resource-permission-alert"
        />
      </div>
    );
  // `record` is narrowed below by the view, not by a second test of it: a 200
  // that carries no object is a failed read, the same as a 500.
  const view = queryView(query, () => false);
  if (view === "loading")
    return (
      <div className="grid gap-4 p-6">
        <Skeleton className="h-12 w-80" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  if (view === "error" || !record)
    return (
      <div className="grid gap-4 p-6">
        <BackLink to={back.to} label={back.label} />
        <LoadFailed
          title={t("detail.loadFailed")}
          onRetry={() => void query.refetch()}
          testId="detail-load-failed"
        />
      </div>
    );
  if (resource === "workflows")
    return (
      <WorkflowPage
        id={id}
        record={record}
        title={recordTitle(record)}
        purpose={recordPurpose(record)}
        permissions={permissions}
      />
    );
  return (
    <ConnectorPage
      id={id}
      record={record}
      title={recordTitle(record)}
      purpose={recordPurpose(record)}
      permissions={permissions}
      returned={returned}
    />
  );
}

export type { DetailResource };
