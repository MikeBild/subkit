import { type AtlassianCloudResource, parseAtlassianCloudResourceUrl } from "./atlassian-tinyui.ts";
import { type NotionResource, parseNotionResourceUrl } from "./notion-page-id.ts";
import type { ConnectorTemplate, ResourceUrlParser } from "./templates.ts";

type TemplateResourceUrl = AtlassianCloudResource | NotionResource;

const PARSERS: Record<ResourceUrlParser, (url: string) => TemplateResourceUrl | null> = {
  atlassian_cloud: parseAtlassianCloudResourceUrl,
  notion: parseNotionResourceUrl,
};

export function resolveTemplateResourceUrl(
  url: string,
  templates: readonly Pick<ConnectorTemplate, "resource_url_parser">[],
): TemplateResourceUrl | null {
  const parsers = new Set<ResourceUrlParser>();
  for (const template of templates)
    if (template.resource_url_parser) parsers.add(template.resource_url_parser);
  for (const parser of parsers) {
    const resource = PARSERS[parser](url);
    if (resource) return resource;
  }
  return null;
}
