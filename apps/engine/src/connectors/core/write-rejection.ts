export type ConnectorWriteRejection =
  | {
      readonly code: "connector_template_unknown";
      readonly message: string;
      readonly details: { readonly template_slug: string };
    }
  | { readonly code: "connector_template_conflict"; readonly message: string };

export type ConnectorWriteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly rejection: ConnectorWriteRejection };

export function connectorTemplateUnknown(template_slug: string): ConnectorWriteRejection {
  return {
    code: "connector_template_unknown",
    message: `unknown connector template: ${template_slug}`,
    details: { template_slug },
  };
}

export const CONNECTOR_TEMPLATE_CONFLICT: ConnectorWriteRejection = {
  code: "connector_template_conflict",
  message: "clear_template_binding cannot be combined with template_slug: send one of them",
};

export function connectorWriteRejected<T>(
  rejection: ConnectorWriteRejection,
): ConnectorWriteOutcome<T> {
  return { ok: false, rejection };
}

export function connectorWriteAccepted<T>(value: T): ConnectorWriteOutcome<T> {
  return { ok: true, value };
}

export function connectorWriteRejectionDetails(
  rejection: ConnectorWriteRejection,
): Record<string, unknown> | undefined {
  return "details" in rejection ? { ...rejection.details } : undefined;
}
