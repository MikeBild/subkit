import { z } from "@hono/zod-openapi";

const DataFlowRoleEnum = z.enum(["source", "destination", "bidirectional", "processing"]);

const CapabilityEnum = z.enum([
  "read",
  "write",
  "search",
  "stream",
  "webhook",
  "subscribe",
  "transform",
]);

const CandidateSchema = z.object({
  name: z.string(),
  kind: z.enum(["http", "graphql", "postgres", "s3"]),
  base_url_guess: z.string().nullable(),
  endpoints: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      summary: z.string(),
    }),
  ),
  auth_kind: z.enum(["none", "header", "query", "bearer", "basic", "oauth2", "unknown"]),
  data_flow_summary: z.string(),
  data_flow_role: DataFlowRoleEnum,
  capabilities: z.array(CapabilityEnum).default([]),
});

const PotentialConnectionSchema = z.object({
  from_system: z.string(),
  to_system: z.string(),
  data_type: z.string(),
  direction: z.enum(["one_way", "bidirectional"]).default("one_way"),
  evidence: z.string().nullable().default(null),
});

export const CandidateEnvelopeSchema = z.object({
  candidates: z.array(CandidateSchema),
  potential_connections: z.array(PotentialConnectionSchema).default([]),
});

export type ConnectorEndpointCandidate = z.infer<typeof CandidateSchema>;
export type ConnectorEndpointCandidateEnvelope = z.infer<typeof CandidateEnvelopeSchema>;
export type PotentialConnection = z.infer<typeof PotentialConnectionSchema>;
