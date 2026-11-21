import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { type ReactElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { retryQuery } from "@/api/client";
import { absolute } from "@/app/links";
import {
  INVITE_ROUTE,
  RECOVERY_ROUTE,
  STANDALONE_ROUTES,
  type StandaloneRoute,
  WELCOME_ROUTE,
} from "@/app/route-table";
import { router } from "@/app/router";
import { SessionGate } from "@/app/session";
import { SetupGate } from "@/app/setup-gate";
import { CockpitUiProvider } from "@/app/ui-provider";
import { I18nProvider } from "@/components/i18n-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { guardDeviceState } from "@/features/pwa";
import { offerFailureRetry } from "@/lib/action-failure";
import { IdentityRecoveryPage } from "@/pages/identity-recovery";
import { InvitePage } from "@/pages/invite";
import { WelcomePage } from "@/pages/welcome";
import "./index.css";
import "./branding.css";

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, variables, _context, mutation) =>
      offerFailureRetry(error, () => void mutation.execute(variables).catch(() => undefined)),
  }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      retry: retryQuery,
    },
    mutations: { retry: false },
  },
});

const STANDALONE_PAGES: Record<StandaloneRoute, () => ReactElement> = {
  [RECOVERY_ROUTE]: IdentityRecoveryPage,
  [WELCOME_ROUTE]: WelcomePage,
  [INVITE_ROUTE]: InvitePage,
};

const standalone = STANDALONE_ROUTES.find((route) => window.location.pathname === absolute(route));
const StandalonePage = standalone ? STANDALONE_PAGES[standalone] : null;

guardDeviceState();

const root = document.getElementById("root");
if (!root) throw new Error("Cockpit root element is missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <CockpitUiProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            {StandalonePage ? (
              <>
                <StandalonePage />
                <Toaster richColors position="bottom-right" />
              </>
            ) : (
              <SessionGate>
                <SetupGate>
                  <RouterProvider router={router} />
                </SetupGate>
              </SessionGate>
            )}
          </TooltipProvider>
        </QueryClientProvider>
      </CockpitUiProvider>
    </I18nProvider>
  </StrictMode>,
);
