// A real S3 server for the suites that must not be answered by a fake.
//
// Four suites used to carry their own copy of this bootstrap, each pinning the
// same image by digest. When that image stopped being published, every one of
// them broke at once and the repair had to be made four times. One fixture, one
// pin.
//
// The store speaks the S3 API over a signed request, which is the point: the
// driver, the object store and the credential resolution are all being tested
// for whether what they send is accepted by a server that checks it. A mock
// that ignores the signature would pass those tests without verifying anything.

const IMAGE =
  "chrislusf/seaweedfs@sha256:bb05d66d2963b1cc48073190781c3dd29e2c4c88a2ae2986bf58e38c86d89c6e";

/** The one identity the fixture serves, written into the container at start. */
const ACCESS_KEY = "subkit-fixture-key";
const SECRET_KEY = "subkit-fixture-secret";
const IDENTITIES = JSON.stringify({
  identities: [
    {
      name: "fixture",
      credentials: [{ accessKey: ACCESS_KEY, secretKey: SECRET_KEY }],
      actions: ["Admin", "Read", "Write", "List", "Tagging"],
    },
  ],
});

export interface ObjectStoreFixture {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  stop: () => Promise<void>;
}

/**
 * Whether these suites can run at all.
 *
 * `SKIP_DOCKER=1` is how CI's test shards run, and a case that could not run
 * must report SKIP rather than PASS — a count that cannot tell "verified" from
 * "never ran" is not evidence, and it is the number a release reads.
 */
export async function dockerAvailable(): Promise<boolean> {
  if (process.env.SKIP_DOCKER === "1") return false;
  const { spawnSync } = await import("node:child_process");
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Start the server and return once it both listens and rejects an unsigned
 * request.
 *
 * The readiness probe is an unauthenticated GET, and the answer it waits for is
 * 403. A 200 would mean the identities file was not read and every signature
 * would be accepted — the fixture would come up, the tests would pass, and they
 * would have checked nothing.
 */
export async function startObjectStore(namePrefix: string): Promise<ObjectStoreFixture> {
  const name = `${namePrefix}-${Math.random().toString(36).slice(2, 8)}`; // allow-random: unique container name per run
  const proc = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-p",
      "0:9000",
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      `printf '%s' '${IDENTITIES}' > /etc/s3.json && exec weed server -dir=/data -s3 -s3.port=9000 -s3.config=/etc/s3.json`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const containerId = (await new Response(proc.stdout).text()).trim();
  if (!containerId) {
    const errText = await new Response(proc.stderr).text();
    throw new Error(`object store fixture did not start: ${errText}`);
  }
  const stop = async () => {
    Bun.spawnSync(["docker", "rm", "-f", containerId]);
  };

  const inspect = Bun.spawnSync([
    "docker",
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}',
    containerId,
  ]);
  const port = Number(new TextDecoder().decode(inspect.stdout).trim());
  if (!port) {
    await stop();
    throw new Error("object store fixture published no port");
  }

  // allow-wall-clock: container warm-up poll before the first request. The
  // server elects a leader before it serves, which takes tens of seconds on a
  // cold start — a deadline tuned to a faster server is how this flakes.
  const deadline = Date.now() + 90_000;
  let authenticating = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 403) {
        authenticating = true;
        break;
      }
      if (res.ok) {
        await stop();
        throw new Error("object store fixture accepted an unsigned request; identities not loaded");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("unsigned request")) throw error;
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: fixture warm-up
  }
  if (!authenticating) {
    await stop();
    throw new Error("object store fixture did not become ready within 90 seconds");
  }

  return {
    endpoint: `http://127.0.0.1:${port}`,
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    stop,
  };
}
