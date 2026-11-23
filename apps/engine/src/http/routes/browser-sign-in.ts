import { cockpitInstallationIdFromPath, signLoginState } from "../../auth/index.ts";

export async function redirectToSignIn(
  path: string,
  query: Record<string, string>,
  publicBaseUrl: string,
  requestPath: string,
): Promise<Response> {
  const installationId = cockpitInstallationIdFromPath(requestPath);
  const apiPrefix = installationId ? `/cockpit/i/${installationId}/api` : "";
  const back = new URL(`${apiPrefix}${path}`, publicBaseUrl);
  for (const [key, value] of Object.entries(query)) back.searchParams.set(key, value);
  const loginUrl = new URL(
    installationId ? `${apiPrefix}/v1/identity/cockpit-login` : "/v1/identity/login/start",
    publicBaseUrl,
  );
  if (installationId) loginUrl.searchParams.set("return_to", `${back.pathname}${back.search}`);
  else
    loginUrl.searchParams.set(
      "login_state",
      await signLoginState({ redirect_to: back.toString() }),
    );
  return Response.redirect(loginUrl.toString(), 302);
}
