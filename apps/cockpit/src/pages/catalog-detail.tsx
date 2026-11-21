import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { apiCall } from "@/api/call";
import { navigationItem } from "@/app/navigation";
import { BackLink, DetailPageLoading } from "@/components/cockpit/patterns";
import { ForbiddenState, LoadFailed, queryView } from "@/components/failure-state";
import { recordTitle } from "@/features/catalog";
import { ConnectorPage, signInReturn, withoutSignInReturn } from "@/features/connectors";
import { WorkflowPage, workflowSchedulesQuery } from "@/features/workflows";
import { useI18n } from "@/lib/i18n-context";

type DetailResource = "workflows" | "connectors";

async function loadDetail(resource: DetailResource, id: string) {
  if (resource === "workflows") return await apiCall("get", "/v1/workflows/{id}", { path: { id } });
  return await apiCall("get", "/v1/connectors/{id}", { path: { id } });
}

const PERMISSIONS: Record<DetailResource, { read: string; write: string }> = {
  workflows: { read: "workflow:read", write: "workflow:write" },
  connectors: { read: "connector:read", write: "connector:write" },
};

function WorkflowWithSchedules({
  id,
  back,
  children,
}: {
  id: string;
  back: { to: string; label: string };
  children: ReactNode;
}) {
  const schedules = useQuery({ ...workflowSchedulesQuery(id), retry: false });
  if (schedules.isLoading)
    return <DetailPageLoading testId="detail-workflows-loading" back={back} purpose />;
  return children;
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
    queryFn: () => loadDetail(resource, id),
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
    return <DetailPageLoading testId={`detail-${resource}-loading`} back={back} purpose />;
  if (view === "error" || !record)
    return (
      <div className="grid gap-4 p-6">
        <BackLink to={back.to} label={back.label} />
        <LoadFailed
          title={t("detail.loadFailed")}
          onRetry={() => void query.refetch()}
          error={query.error}
          testId="detail-load-failed"
        />
      </div>
    );
  if (resource === "workflows")
    return (
      <WorkflowWithSchedules back={back} id={id}>
        <WorkflowPage
          id={id}
          record={record}
          title={recordTitle(record)}
          permissions={permissions}
        />
      </WorkflowWithSchedules>
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
