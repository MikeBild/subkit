// Inbound: /v1/hooks/:slug with Standard Webhooks verifier + connector-
// native verifiers + replay-id dedup. Outbound: Standard Webhooks signed
// deliveries with retry cadence, dead-letter, replay, circuit breaker.
// Implemented in P7.
export {};
