CREATE TABLE "risk_signal_edges" (
	"kind" text PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
