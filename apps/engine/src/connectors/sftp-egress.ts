import { Socket } from "node:net";
import type { SftpAddress } from "./core/sftp.ts";
import {
  assertEgressAllowed,
  EgressBlockedError,
  type EgressGuardContext,
  grantedLocalTarget,
  resolveAllowedEgressAddresses,
  resolveEgressGuardMode,
  resolveTenantEgressContext,
} from "./egress-guard.ts";
import { ownTargetScope } from "./local-egress.ts";

export function sftpTarget(address: SftpAddress): URL {
  const host =
    address.host.includes(":") && !address.host.startsWith("[")
      ? `[${address.host}]`
      : address.host;
  return new URL(`sftp://${host}:${address.port}/`);
}

async function sftpDialTarget(
  address: SftpAddress,
  context: EgressGuardContext,
): Promise<{ host: string; family?: number }> {
  const target = sftpTarget(address);
  const ownScope = context.local_mcp ? undefined : ownTargetScope(target);
  const resolved = await resolveTenantEgressContext(
    ownScope ? { ...context, local_mcp: ownScope } : context,
  );
  if (resolveEgressGuardMode(resolved) === "permissive" || grantedLocalTarget(target, resolved)) {
    assertEgressAllowed(target, resolved);
    return { host: address.host };
  }
  const addresses = await resolveAllowedEgressAddresses(target, resolved);
  const first = addresses[0];
  if (!first) throw new EgressBlockedError("dns_resolution_failed", address.host);
  return { host: first.address, family: first.family };
}

export async function openSftpSocket(
  address: SftpAddress,
  context: EgressGuardContext,
  timeoutMs: number,
): Promise<Socket> {
  const dial = await sftpDialTarget(address, context);
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`sftp connection to ${address.host}:${address.port} timed out`));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.connect(
      { host: dial.host, port: address.port, ...(dial.family ? { family: dial.family } : {}) },
      () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        resolve();
      },
    );
  });
  return socket;
}
