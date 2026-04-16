// Outbox write helper and catch-up reader. Every event is written to the
// `events` table inside the same transaction as the domain write; NOTIFY
// is issued after commit. Implemented in P3.
export {};
