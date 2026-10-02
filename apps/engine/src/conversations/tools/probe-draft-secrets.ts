// Where a connector draft becomes a request: its masks are resolved here.
//
// A draft bound to a saved connector was hydrated from that connector's
// public projection, so it holds the mask where the connector stores a secret
// (a static header, the dsn password). The draft never carries the secret;
// the probe reads it from the stored connector at the moment it sends.
//
// The same rule as a connector write applies: a mask stands for the stored
// secret only while the draft still points where that secret was stored for.
// A draft whose host was edited, or whose saved connector is gone, has nothing
// the mask could stand for — the probe is refused rather than sent with the
// stored secret to the new host, or with the literal mask as a credential.

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
      /** The gate error the tool answers with. */
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
