import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { getCurrentCockpitInstallation } from "@/api/cockpit-installations";
import { attentionWorker } from "@/app/attention-notice";
import { cockpitBasePath, installationId } from "@/app/installation-context";
import { routerPath, routerTarget } from "@/app/links";
import { useLiveStatus } from "@/app/live-events";
import { useSession } from "@/app/session";
import { useAttention } from "@/app/use-attention";
import { badgeCount, showAppBadge } from "./app-badge";
import { deepLinkRoute, LINK_PARAM, launchRoute } from "./deep-link";
import { closeInstall, openInstall, useInstallOpen } from "./install-store";
import { onLaunch } from "./launch";
import { InstallationDialog } from "./ui/installation-dialogs";
import { checkForWorkerUpdate, watchInstallationWorker } from "./worker-update";

function InstallHost() {
  const session = useSession();
  const open = useInstallOpen();
  const installation = useQuery({
    queryKey: ["cockpit-installation"],
    queryFn: getCurrentCockpitInstallation,
    retry: false,
    enabled: open,
  });
  return (
    <InstallationDialog
      open={open}
      onOpenChange={(next) => (next ? openInstall() : closeInstall())}
      tenantName={session.tenant.display_name}
      installation={installation.data?.installation ?? null}
    />
  );
}

function useAppBadge(): void {
  const session = useSession();
  const { query, badge } = useAttention(session.permissions);
  const loaded = query.isSuccess;
  const count = badgeCount(badge);
  useEffect(() => {
    if (loaded) void showAppBadge(count);
  }, [loaded, count]);
}

function useLaunchTargets(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const open = (route: string | null, replace: boolean) => {
      if (route !== null) void navigate({ ...routerTarget(route), replace });
    };
    const url = new URL(window.location.href);
    if (url.searchParams.has(LINK_PARAM))
      open(deepLinkRoute(url.searchParams.get(LINK_PARAM)) ?? "/", true);
    const stopLaunch = onLaunch((target) => open(launchRoute(target, cockpitBasePath()), false));
    const container = navigator.serviceWorker;
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (!data || typeof data !== "object" || data.type !== "open") return;
      if (typeof data.href !== "string") return;
      if (!attentionWorker(event.source, window.location.origin, cockpitBasePath())) return;
      open(launchRoute(data.href, cockpitBasePath()) ?? routerPath(cockpitBasePath()), false);
    };
    container?.addEventListener("message", receive);
    return () => {
      stopLaunch();
      container?.removeEventListener("message", receive);
    };
  }, [navigate]);
}

function useWorkerUpdates(): void {
  const { status, serverVersion } = useLiveStatus();
  useEffect(() => watchInstallationWorker(), []);
  useEffect(() => {
    if (status === "live" && installationId()) checkForWorkerUpdate();
  }, [status, serverVersion]);
}

export function PwaRuntime() {
  useAppBadge();
  useLaunchTargets();
  useWorkerUpdates();
  return <InstallHost />;
}
