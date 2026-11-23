import { NOW, TENANT } from "./journey-fixtures";

export const PROD_CONNECTOR = "66666666-6666-4666-8666-666666666666";

const prodConnector = {
  id: PROD_CONNECTOR,
  slug: "app-store-connect",
  display_name: "App Store Connect",
  description: null,
  description_source: "human",
  category: "harmoniqs",
  category_source: "human",
  driver: "http",
  environment: "prod",
  auth_type: "signed_jwt",
  base_url: "https://api.appstoreconnect.apple.com",
  dsn: null,
  config: {},
  operator_quirks: {},
  template_slug: null,
  template_name: null,
  template_source: null,
  template_version: null,
  template_snapshot: null,
  enabled: true,
  last_error: null,
  health_state: "ok",
  health_reason: null,
  health_error_code: null,
  circuit_state: "closed",
  circuit_opened_at: null,
  circuit_failure_count: 0,
  needs_reauth: false,
  auth_failed_at: null,
  auth_failed_reason: null,
  sign_in: null,
  tenant_id: TENANT,
  created_at: NOW,
  updated_at: NOW,
  last_tested_at: null,
  tools_count: null,
  credentials: [],
  credential: null,
};

export function missingProdCredential(workflowId: string) {
  return {
    [`/v1/workflows/${workflowId}/diagnosis`]: () => ({
      workflow_id: workflowId,
      workflow_version_id: null,
      environment: "prod",
      is_current: true,
      diagnoses: [
        {
          code: "connector_unavailable",
          subject: { step_id: "fetch_beta_group" },
          evidence: {
            connector: {
              connector_id: PROD_CONNECTOR,
              connector_slug: "app-store-connect",
              connector_name: "App Store Connect",
              environment: "prod",
              reason: "credential_unavailable",
            },
          },
          remedy_kind: "reconnect",
          reconnect: { connector_id: PROD_CONNECTOR, environment: "prod", section: "credentials" },
        },
      ],
    }),
    [`/v1/connectors/${PROD_CONNECTOR}`]: () => prodConnector,
    [`/v1/connectors/${PROD_CONNECTOR}/credential`]: () => null,
  };
}
