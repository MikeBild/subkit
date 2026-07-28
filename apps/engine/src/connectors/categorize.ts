// The connector catalog's grouping rule.
//
// Workflows derive their category from the slug corpus, because their slugs
// carry families (`notion-*`, `mission-control-*`). Connector slugs are single
// tokens (`gmail`, `notion`, `ga4`), so there is nothing to derive — a
// connector already stores an axis that groups usefully: the driver.
//
// Stated once here rather than inlined as `row.driver` at each call site, so
// the HTTP list and the chat fast path cannot drift apart on what a connector
// category is.

export function categoryOfConnector(connector: { driver: string }): string {
  return connector.driver;
}
