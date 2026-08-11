import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AccessPage, ApiAccessPage, OperationsPage, PeoplePage, SettingsPage } from "@/pages/admin";
import { ChatPage } from "@/pages/chat";
import { RESOURCE_CONFIGS, ResourcePage } from "@/pages/resource";
import { useSession } from "./session";
import { AppShell } from "./shell";

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/chat" });
  },
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatPage,
});

const dedicatedRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/people", component: PeoplePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/access", component: AccessPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/api-access", component: ApiAccessPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/operations", component: OperationsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
];
const dedicatedResources = new Set(["people", "access", "api-access", "operations", "settings"]);

const resourceRoutes = Object.keys(RESOURCE_CONFIGS)
  .filter((resource) => !dedicatedResources.has(resource))
  .map((resource) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${resource}`,
      component: () => {
        const session = useSession();
        return <ResourcePage resource={resource} permissions={session.permissions} />;
      },
    }),
  );

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  ...dedicatedRoutes,
  ...resourceRoutes,
]);

export const router = createRouter({ routeTree, basepath: "/cockpit" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
