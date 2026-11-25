import { createHash, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { RELEASE_PUBLIC_KEY } from "@cli-core/release-public-key";
import {
  checksumUrls,
  judgeDownload,
  type ManifestVerdict,
  RELEASE_REPOSITORY,
} from "../shared/update-manifest.ts";

async function fetchOk(url: string, fetcher: typeof fetch): Promise<Response> {
  const response = await fetcher(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response;
}

export async function verifyDownloadedUpdate(
  version: string,
  filePath: string,
  fetcher: typeof fetch = fetch,
): Promise<ManifestVerdict> {
  const urls = checksumUrls(RELEASE_REPOSITORY, version);
  const [manifest, signature, file] = await Promise.all([
    fetchOk(urls.manifest, fetcher).then((response) => response.text()),
    fetchOk(urls.signature, fetcher).then(async (response) =>
      Buffer.from(await response.arrayBuffer()),
    ),
    readFile(filePath),
  ]);
  return judgeDownload({
    signatureValid: verify(null, Buffer.from(manifest, "utf8"), RELEASE_PUBLIC_KEY, signature),
    manifest,
    fileName: basename(filePath),
    sha256: createHash("sha256").update(file).digest("hex"),
  });
}
