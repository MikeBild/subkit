import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiRequest } from "@/api/client";
import { navigationItem } from "@/app/navigation";
import { ConnectorPage } from "@/components/cockpit/connector-page";
import { BackLink, Skeleton } from "@/components/cockpit/patterns";
import { WorkflowPage } from "@/components/cockpit/workflow-page";
import { ForbiddenState, LoadFailed, queryView } from "@/components/failure-state";
import { useI18n } from "@/lib/i18n-context";
import { type RecordValue, recordTitle } from "@/pages/catalog-model";
import { signInReturn, withoutSignInReturn } from "@/pages/connector-detail-model";

type DetailResource = "workflows" | "connectors";

const ENDPOINTS: Record<DetailResource, string> = {
  workflows: "/v1/workflows",
  connectors: "/v1/connectors",
};

const PERMISSIONS: Record<DetailResource, { read: string; write: string }> = {
  workflows: { read: "workflow:read", write: "workflow:write" },
  connectors: { read: "connector:read", write: "connector:write" },
};

export function CatalogDetailPage({
  resource,
  permissions,
}: {
  resource: DetailResource;
  permissions: readonly string[];
}) {
  const { t } = useI18n();
  const id = decodeURIComponent(window.location.pathname.split("/").filter(Boolean).at(-1) ?? "");
  const [returned] = useState(() =>
    resource === "connectors" ? signInReturn(window.location.search) : null,
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
        <ForbiddenState />
      </div>
    );
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
      <WorkflowPage id={id} record={record} title={recordTitle(record)} permissions={permissions} />
    );
  return (
    <ConnectorPage
      id={id}
      record={record}
      title={recordTitle(record)}
      permissions={permissions}
      returned={returned}
    />
  );
}

export type { DetailResource };
