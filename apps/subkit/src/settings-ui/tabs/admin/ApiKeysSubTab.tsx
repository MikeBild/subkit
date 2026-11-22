import { osc52Copy } from "@cli-core/clipboard.ts";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { EngineClient } from "../../../engine-client.ts";
import { ConsentPrompt } from "../../../repl/components/ConsentPrompt.tsx";
import { AdminCreateForm } from "./AdminCreateForm.tsx";

interface Props {
  client: EngineClient;
  onInnerEscape?: (active: boolean) => void;
}

interface KeyRow {
  id: string;
  name: string;
  status: string;
  lastUsed: string | null;
}

type Schemas = components["schemas"];
type ApiKey = Schemas["ApiKey"];
type IssueApiKeyBody = Schemas["IssueApiKeyBody"];
type OwnerKind = IssueApiKeyBody["owner_kind"];

const OWNER_KINDS: readonly OwnerKind[] = ["user", "system_account"];

function keyRow(key: ApiKey): KeyRow {
  return {
    id: key.id,
    name: key.name || key.id,
    status: key.revoked_at ? "revoked" : "active",
    lastUsed: key.last_used_at,
  };
}

function parseOwnerKind(raw: string | undefined): OwnerKind {
  const value = (raw ?? "").trim();
  const match = OWNER_KINDS.find((kind) => kind === value);
  if (!match) throw new Error(`Owner kind must be ${OWNER_KINDS.join(" or ")}`);
  return match;
}

export function issueApiKeyBody(vals: Record<string, string>): IssueApiKeyBody {
  const scopes = (vals.scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const expiresAt = vals.expires_at?.trim();
  return {
    owner_id: vals.owner_id?.trim() ?? "",
    owner_kind: parseOwnerKind(vals.owner_kind),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

export const ApiKeysSubTab: React.FC<Props> = ({ client, onInnerEscape }) => {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listIdx, setListIdx] = useState(0);
  const [pendingRevoke, setPendingRevoke] = useState<KeyRow | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedSecret, setIssuedSecret] = useState<{ id: string; token: string } | null>(null);

  useEffect(() => {
    onInnerEscape?.(pendingRevoke !== null || createOpen || issuedSecret !== null);
  }, [pendingRevoke, createOpen, issuedSecret, onInnerEscape]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .listApiKeys()
      .then((res) => {
        if (cancelled) return;
        setRows(res.items.map(keyRow));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, refreshKey]);

  useInput((input, key) => {
    if (pendingRevoke || createOpen || issuedSecret) return;
    if (key.upArrow) {
      setListIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setListIdx((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (input === "x") {
      const sel = rows[listIdx];
      if (sel) setPendingRevoke(sel);
      return;
    }
    if (input === "r") {
      setRefreshKey((k) => k + 1);
      return;
    }
    if (input === "c") {
      setCreateOpen(true);
      return;
    }
  });

  const onConfirmRevoke = async (): Promise<void> => {
    if (!pendingRevoke) return;
    try {
      await client.revokeApiKey(pendingRevoke.id);
      setRows((prev) =>
        prev.map((r) => (r.id === pendingRevoke.id ? { ...r, status: "revoked" } : r)),
      );
      setActionFlash(`revoked ${pendingRevoke.name}`);
    } catch (err) {
      setActionFlash(`revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setPendingRevoke(null);
  };

  return (
    <Box flexDirection="column">
      <Text bold>API keys</Text>
      <Text color="gray">↑/↓ navigate · c create · x revoke · r refresh</Text>
      <Box marginTop={1} flexDirection="column">
        {loading ? <Text>loading…</Text> : null}
        {error ? <Text color="red">failed: {error}</Text> : null}
        {actionFlash ? <Text color="cyan">{actionFlash}</Text> : null}
        {!loading && !error && rows.length === 0 ? <Text color="gray">no api keys</Text> : null}
        {rows.map((r, i) => (
          <Box key={r.id}>
            <Text color={i === listIdx ? "cyan" : "white"}>{i === listIdx ? "› " : "  "}</Text>
            <Text>{r.name}</Text>
            <Text color={r.status === "active" ? "green" : "gray"}> [{r.status}]</Text>
            {r.lastUsed ? <Text color="gray"> · last used {r.lastUsed}</Text> : null}
          </Box>
        ))}
      </Box>
      {createOpen ? (
        <Box marginTop={1}>
          <AdminCreateForm
            title="Issue API key"
            fields={[
              { key: "owner_id", label: "Owner id", required: true, placeholder: "user uuid" },
              {
                key: "owner_kind",
                label: "Owner kind",
                required: true,
                placeholder: "user | system_account",
              },
              { key: "scopes", label: "Scopes (csv)", placeholder: "rbac:read,audit:read" },
              { key: "expires_at", label: "Expires at", placeholder: "2026-12-31T00:00:00Z" },
            ]}
            onSubmit={async (vals) => {
              const issued = await client.issueApiKey(issueApiKeyBody(vals));
              setCreateOpen(false);
              setRefreshKey((k) => k + 1);
              if (issued.plaintext_key) {
                setIssuedSecret({ id: issued.id, token: issued.plaintext_key });
              } else {
                setActionFlash(`issued ${issued.id} — engine did not return plaintext_key`);
              }
            }}
            onCancel={() => setCreateOpen(false)}
          />
        </Box>
      ) : null}
      {issuedSecret ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="yellow">
            New api key — copy it now. The engine never echoes the plaintext again.
          </Text>
          <Box marginTop={1}>
            <Text color="gray">id: </Text>
            <Text>{issuedSecret.id}</Text>
          </Box>
          <Box>
            <Text color="gray">token: </Text>
            <Text>{issuedSecret.token}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Press y to copy to clipboard · n to dismiss</Text>
          </Box>
          <SecretConfirm
            token={issuedSecret.token}
            onAck={(copied) => {
              if (copied)
                setActionFlash(`token copied to clipboard for api key ${issuedSecret.id}`);
              setIssuedSecret(null);
            }}
          />
        </Box>
      ) : null}
      {pendingRevoke ? (
        <Box marginTop={1}>
          <ConsentPrompt
            title={`Revoke api key "${pendingRevoke.name}"?`}
            body="The key cannot be used again. Existing tokens issued from it remain valid until expiry."
            yesLabel="Revoke"
            noLabel="Cancel"
            onYes={onConfirmRevoke}
            onNo={() => setPendingRevoke(null)}
          />
        </Box>
      ) : null}
    </Box>
  );
};

const SecretConfirm: React.FC<{ token: string; onAck: (copied: boolean) => void }> = ({
  token,
  onAck,
}) => {
  useInput((input) => {
    if (input === "y") {
      const ok = osc52Copy(token);
      onAck(ok);
      return;
    }
    if (input === "n") {
      onAck(false);
      return;
    }
  });
  return null;
};
