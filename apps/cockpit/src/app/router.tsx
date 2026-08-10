import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
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

const resourceRoutes = Object.keys(RESOURCE_CONFIGS).map((resource) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}`,
    component: () => {
      const session = useSession();
      return <ResourcePage resource={resource} permissions={session.permissions} />;
    },
  }),
);

const routeTree = rootRoute.addChildren([indexRoute, chatRoute, ...resourceRoutes]);

export const router = createRouter({ routeTree, basepath: "/cockpit" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
