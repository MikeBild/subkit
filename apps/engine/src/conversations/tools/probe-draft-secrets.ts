import { restoreMaskedConnectorSecrets } from "../../connectors/public-view.ts";
import { getConnector } from "../../connectors/service.ts";
import type { Executor } from "../../db/client.ts";
import { UnprocessableEntityError } from "../../http/errors.ts";
import type { ConnectorDraftDocument } from "../types.ts";

export type DraftProbeSecrets =
  | {
      ok: true;
      base_url: string | null;
      dsn: string | null;
      config: Record<string, unknown>;
    }
  | {
      ok: false;
      refusal: {
        error_code: "connector_secret_not_kept";
        message: string;
        next_best_actions: string[];
        recommended_mode: "connector";
        requires_user_input: true;
      };
    };

export async function resolveDraftProbeSecrets(
  tenant_id: string,
  connector: ConnectorDraftDocument,
  db: Executor,
): Promise<DraftProbeSecrets> {
  const saved = connector.saved_connector_id
    ? await getConnector(tenant_id, connector.saved_connector_id, db)
    : null;
  try {
    const secrets = restoreMaskedConnectorSecrets(
      {
        base_url: connector.base_url ?? null,
        config: connector.config ?? {},
        ...(connector.dsn !== undefined ? { dsn: connector.dsn } : {}),
      },
      saved,
    );
    return {
      ok: true,
      base_url: secrets.base_url ?? null,
      dsn: secrets.dsn ?? null,
      config: secrets.config ?? {},
    };
  } catch (error) {
    if (!(error instanceof UnprocessableEntityError)) throw error;
    return {
      ok: false,
      refusal: {
        error_code: "connector_secret_not_kept",
        message: error.message,
        next_best_actions: ["ask_user_form", "update_connector_draft"],
        recommended_mode: "connector",
        requires_user_input: true,
      },
    };
  }
}
