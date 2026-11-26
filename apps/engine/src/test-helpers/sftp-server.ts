import { createHash } from "node:crypto";
import { type Connection, type ParsedKey, Server, utils } from "ssh2";

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

export interface TestSftpServer {
  port: number;
  publicKeyLogins: () => number;
  host_key_sha256: string;
  files: Map<string, Buffer>;
  sessions: () => number;
  close: () => Promise<void>;
}

interface OpenHandle {
  path: string;
  write: boolean;
  chunks: Buffer[];
  listed: boolean;
}

function attrs(size: number, folder: boolean) {
  return {
    mode: folder ? 0o040755 : 0o100644,
    uid: 0,
    gid: 0,
    size,
    atime: 1_700_000_000,
    mtime: 1_700_000_000,
  };
}

function folderEntries(files: Map<string, Buffer>, folder: string) {
  const prefix = folder === "/" ? "/" : `${folder}/`;
  const seen = new Map<string, { size: number; folder: boolean }>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [name, ...deeper] = rest.split("/");
    if (!name) continue;
    seen.set(name, { size: deeper.length > 0 ? 0 : bytes.length, folder: deeper.length > 0 });
  }
  return [...seen.entries()].map(([filename, info]) => ({
    filename,
    longname: filename,
    attrs: attrs(info.size, info.folder),
  }));
}

type SshKeyPair = ReturnType<typeof utils.generateKeyPairSync>;
type SshKeyPairOptions = Parameters<typeof utils.generateKeyPairSync>[1];

const parses = (text: string, passphrase?: string | Buffer) =>
  !(utils.parseKey(text, passphrase) instanceof Error);

export function generateSshKeyPair(options?: SshKeyPairOptions, attempts = 32): SshKeyPair {
  const passphrase = options && "passphrase" in options ? options.passphrase : undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pair = options
      ? utils.generateKeyPairSync("ed25519", options)
      : utils.generateKeyPairSync("ed25519");
    if (parses(pair.public) && parses(pair.private, passphrase)) return pair;
  }
  throw new Error(`ssh2 produced no parseable ed25519 key pair in ${attempts} attempts`);
}

export interface TestSftpServerOptions {
  authorizedKey?: { username: string; publicKey: string };
}

function publicKeyOf(text: string): ParsedKey {
  const parsed = utils.parseKey(text) as ParsedKey | ParsedKey[] | Error;
  if (parsed instanceof Error) throw parsed;
  return (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
}

function serveSftp(
  client: Connection,
  files: Map<string, Buffer>,
  credentials: [string, string],
  authorized: { username: string; key: ParsedKey } | null,
  onPublicKeyLogin: () => void,
) {
  client.on("authentication", (auth) => {
    if (
      auth.method === "password" &&
      auth.username === credentials[0] &&
      auth.password === credentials[1]
    )
      return auth.accept();
    if (
      auth.method === "publickey" &&
      authorized &&
      auth.username === authorized.username &&
      auth.key.algo === authorized.key.type &&
      auth.key.data.equals(authorized.key.getPublicSSH())
    ) {
      if (!auth.signature || !auth.blob) return auth.accept();
      if (authorized.key.verify(auth.blob, auth.signature, auth.hashAlgo) === true) {
        onPublicKeyLogin();
        return auth.accept();
      }
    }
    auth.reject(authorized ? ["password", "publickey"] : ["password"]);
  });
  client.on("ready", () => {
    client.on("session", (acceptSession) => {
      acceptSession().on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map<number, OpenHandle>();
        let next = 1;
        const handleOf = (buf: Buffer) => handles.get(buf.readUInt32BE(0));
        const newHandle = (entry: OpenHandle) => {
          const id = next++;
          handles.set(id, entry);
          const buf = Buffer.alloc(4);
          buf.writeUInt32BE(id);
          return buf;
        };
        sftp.on("OPENDIR", (reqid, path) => {
          sftp.handle(reqid, newHandle({ path, write: false, chunks: [], listed: false }));
        });
        sftp.on("READDIR", (reqid, handle) => {
          const entry = handleOf(handle);
          if (!entry || entry.listed) return sftp.status(reqid, STATUS_CODE.EOF);
          entry.listed = true;
          sftp.name(reqid, folderEntries(files, entry.path));
        });
        sftp.on("OPEN", (reqid, path, flags) => {
          const write = (flags & OPEN_MODE.WRITE) !== 0;
          if (!write && !files.has(path)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          sftp.handle(reqid, newHandle({ path, write, chunks: [], listed: false }));
        });
        sftp.on("READ", (reqid, handle, offset, length) => {
          const entry = handleOf(handle);
          const bytes = entry ? files.get(entry.path) : undefined;
          if (!bytes || offset >= bytes.length) return sftp.status(reqid, STATUS_CODE.EOF);
          sftp.data(reqid, bytes.subarray(offset, offset + length));
        });
        sftp.on("WRITE", (reqid, handle, _offset, data) => {
          handleOf(handle)?.chunks.push(Buffer.from(data));
          sftp.status(reqid, STATUS_CODE.OK);
        });
        sftp.on("FSTAT", (reqid, handle) => {
          const entry = handleOf(handle);
          sftp.attrs(reqid, attrs(entry ? (files.get(entry.path)?.length ?? 0) : 0, false));
        });
        sftp.on("STAT", (reqid, path) => {
          const bytes = files.get(path);
          if (!bytes) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          sftp.attrs(reqid, attrs(bytes.length, false));
        });
        sftp.on("CLOSE", (reqid, handle) => {
          const id = handle.readUInt32BE(0);
          const entry = handles.get(id);
          if (entry?.write) files.set(entry.path, Buffer.concat(entry.chunks));
          handles.delete(id);
          sftp.status(reqid, STATUS_CODE.OK);
        });
        sftp.on("REMOVE", (reqid, path) => {
          if (!files.delete(path)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          sftp.status(reqid, STATUS_CODE.OK);
        });
      });
    });
  });
  client.on("error", () => {});
}

export async function startTestSftpServer(
  credentials: [string, string],
  options: TestSftpServerOptions = {},
): Promise<TestSftpServer> {
  const hostKey = generateSshKeyPair();
  const files = new Map<string, Buffer>();
  const authorized = options.authorizedKey
    ? {
        username: options.authorizedKey.username,
        key: publicKeyOf(options.authorizedKey.publicKey),
      }
    : null;
  let sessions = 0;
  let publicKeyLogins = 0;
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    sessions += 1;
    serveSftp(client, files, credentials, authorized, () => {
      publicKeyLogins += 1;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const parsed = utils.parseKey(hostKey.public) as ParsedKey | ParsedKey[];
  const publicKey = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
  const digest = createHash("sha256").update(publicKey.getPublicSSH()).digest("base64");
  return {
    port: (server.address() as { port: number }).port,
    host_key_sha256: `SHA256:${digest.replace(/=+$/, "")}`,
    files,
    sessions: () => sessions,
    publicKeyLogins: () => publicKeyLogins,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
