export const MAX_INLINE_BYTES = 5 * 1024 * 1024;

export const FILE_LINK_RESOURCE_TYPES = [
  "conversation",
  "knowledge_source",
  "skill",
  "connector",
  "workflow_run",
  "discovery_run",
] as const;

export type FileLinkResourceType = (typeof FILE_LINK_RESOURCE_TYPES)[number];
