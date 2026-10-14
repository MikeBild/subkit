import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function cockpitDemoDatabaseGeneration(instance, root, run = spawnSync) {
  const compose = [
    "compose",
    "--env-file",
    "/dev/null",
    "-p",
    instance.project,
    "-f",
    "docker-compose.test.yml",
    "-f",
    "docker-compose.demo.yml",
  ];
  const listed = run("docker", [...compose, "ps", "-q", "postgres"], {
    cwd: root,
    encoding: "utf8",
  });
  const containerId = listed.status === 0 ? listed.stdout.trim() : "";
  if (!/^[0-9a-f]{64}$/i.test(containerId))
    throw new Error("Selected local demo database container identity is unavailable");
  const inspected = run(
    "docker",
    [
      "inspect",
      "--format",
      "{{.Id}}|{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Source}}:{{.Destination}};{{end}}",
      containerId,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const identity = inspected.status === 0 ? inspected.stdout.trim() : "";
  if (!identity.startsWith(`${containerId}|`) || !identity.includes("/var/lib/postgresql"))
    throw new Error("Selected local demo database volume identity is unavailable");
  return createHash("sha256").update(identity).digest("hex");
}
