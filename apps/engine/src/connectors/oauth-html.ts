// Shared HTML rendering helpers for OAuth2 browser-facing pages.
//
// Used by:
//   - GET /v1/oauth/callback (success / failure page)
//   - GET /v1/connectors/{id}/oauth/start?grant=… (error page on
//     invalid/expired grant, or failure after a consumed grant)

export interface OAuthCallbackPage {
  kind: "success" | "error";
  title: string;
  message: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render an OAuth2 browser page (success or error) as an HTML string.
 * Returns the raw body and the HTTP status code.
 *
 * Security: `page.title` and `page.message` must NEVER contain the raw
 * grant token, `state` token, or any other secret. Callers are
 * responsible for stripping sensitive values before calling this.
 */
export function buildCallbackPageHtml(page: OAuthCallbackPage): {
  html: string;
  status: 200 | 400;
} {
  const status = page.kind === "success" ? 200 : 400;
  const colour = page.kind === "success" ? "#16a34a" : "#dc2626";
  const safeTitle = escapeHtml(page.title);
  const safeMessage = escapeHtml(page.message);
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fafafa; color: #111; }
    main { max-width: 560px; margin: 96px auto; padding: 32px; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { color: ${colour}; margin: 0 0 16px; font-size: 22px; }
    p { white-space: pre-wrap; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </main>
</body>
</html>`;
  return { html, status };
}
