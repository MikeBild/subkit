import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const agents = readFileSync("AGENTS.md", "utf8");
const repository = readme.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/issues/)?.[1];
const projectMatch = readme.match(/https:\/\/github\.com\/users\/([^/]+)\/projects\/(\d+)/);
const failures = [];
if (!repository || !projectMatch)
  throw new Error("README must link repository Issues and its GitHub Project.");
for (const [name, text] of [
  ["README.md", readme],
  ["AGENTS.md", agents],
]) {
  for (const suffix of ["issues", "wiki", "milestones"])
    if (!text.includes(`https://github.com/${repository}/${suffix}`))
      failures.push(`${name}: add the direct GitHub ${suffix} link.`);
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!/^(https?:|mailto:)/.test(target) && target && !existsSync(target))
      failures.push(`${name}: broken local link ${target}.`);
  }
}
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
}).split("\n");
for (const file of files) {
  if (!existsSync(file)) continue;
  if (
    /^(?:docs\/.*\.md|(?:TODO|LAUNCH(?:_[A-Z]+)?|WEBSITE-TODO)\.md|docs\/roadmap-issues\.json)$/i.test(
      file,
    )
  )
    failures.push(`${file}: move planning and human documentation to GitHub.`);
}
if (process.argv.includes("--live")) {
  const gh = (args) =>
    JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const issues = gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues?state=all&per_page=100`,
  ])
    .flat()
    .filter((issue) => !issue.pull_request);
  const project = gh([
    "project",
    "item-list",
    projectMatch[2],
    "--owner",
    projectMatch[1],
    "--limit",
    "1000",
    "--format",
    "json",
  ]);
  if (project.items.length < project.totalCount)
    failures.push("Project inventory is incomplete; increase the retrieval bound.");
  for (const issue of issues.filter((item) => item.state === "open")) {
    const item = project.items.find((entry) => entry.content?.url === issue.html_url);
    if (!item) {
      failures.push(`Issue #${issue.number}: add it to the GitHub Project.`);
      continue;
    }
    for (const field of ["status", "priority", "track"])
      if (!item[field]) failures.push(`Issue #${issue.number}: set Project ${field}.`);
    if (item.status === "Done")
      failures.push(`Issue #${issue.number}: open Issue is marked Done in the Project.`);
    const priorities = issue.labels
      .map((label) => label.name)
      .filter((name) => name.startsWith("priority:"));
    const priority = priorities[0];
    if (priorities.length !== 1 || !/^priority:P[012]$/.test(priority ?? ""))
      failures.push(`Issue #${issue.number}: use exactly one priority:P0/P1/P2 label.`);
    else if (priority.slice(9) !== item.priority)
      failures.push(`Issue #${issue.number}: align priority label and Project field.`);
  }
  for (const item of project.items) {
    const issue = issues.find((entry) => entry.html_url === item.content?.url);
    if (issue?.state === "closed" && item.status !== "Done")
      failures.push(`Issue #${issue.number}: closed Issue must be Done in the Project.`);
  }
  console.log(
    `Live inventory: ${issues.filter((issue) => issue.state === "open").length} open Issues; ${project.items.length} Project items.`,
  );
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log("GitHub source ownership: PASS.");
