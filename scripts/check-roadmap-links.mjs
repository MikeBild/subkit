import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("docs/roadmap-issues.json", "utf8"));
const launch = readFileSync("LAUNCH_STATUS.md", "utf8");
const hosted = readFileSync("docs/TODO.md", "utf8");
const website = readFileSync("WEBSITE-TODO.md", "utf8");
const failures = [];
const expectedHosted = Array.from(
  { length: 9 },
  (_, index) => `C${String(index + 1).padStart(2, "0")}`,
);
const expectedLaunch = [
  ...launch.matchAll(/^\| (L\d\d) \| (TODO|IN_PROGRESS|BLOCKED|UNVERIFIED) \|/gm),
].map((match) => match[1]);
const expectedWebsite = [...website.matchAll(/^### ([1-4])\. /gm)].map(
  (match) => `W${match[1].padStart(2, "0")}`,
);
const issuePattern = /^https:\/\/github\.com\/MikeBild\/subkit\/issues\/[1-9]\d*$/;
const allUrls = new Set();

if (root.repository !== "MikeBild/subkit") failures.push("Repository-Zuordnung ist falsch.");
if (root.projectUrl !== "https://github.com/users/MikeBild/projects/4")
  failures.push("Project-Zuordnung ist falsch.");
for (const [section, expected] of Object.entries({
  hosted: expectedHosted,
  launch: expectedLaunch,
  website: expectedWebsite,
})) {
  const actual = Object.keys(root[section] ?? {});
  for (const id of expected)
    if (!actual.includes(id)) failures.push(`Fehlende ${section}-Zuordnung: ${id}`);
  for (const id of actual)
    if (!expected.includes(id)) failures.push(`Nicht mehr offene ${section}-Zuordnung: ${id}`);
}
for (const id of expectedHosted)
  if (!hosted.includes(id)) failures.push(`Hosted-Aufgabe ohne Dokumentquelle: ${id}`);
for (const [section, entries] of Object.entries({
  hosted: root.hosted,
  launch: root.launch,
  website: root.website,
  bugs: root.bugs,
  existingBacklog: root.existingBacklog,
})) {
  for (const [id, url] of Object.entries(entries ?? {})) {
    if (!issuePattern.test(url)) failures.push(`Ungültige Issue-URL: ${section}.${id}`);
    if (allUrls.has(url)) failures.push(`Doppelte Issue-URL: ${section}.${id}`);
    allUrls.add(url);
  }
}
for (const [name, url] of Object.entries(root.projectViews ?? {})) {
  if (!/^https:\/\/github\.com\/users\/MikeBild\/projects\/4\/views\/[1-9]\d*$/.test(url))
    failures.push(`Ungültige Project-Ansicht: ${name}`);
}
for (const [name, url] of Object.entries(root.milestones ?? {})) {
  if (!/^https:\/\/github\.com\/MikeBild\/subkit\/milestone\/[1-9]\d*$/.test(url))
    failures.push(`Ungültiger Milestone: ${name}`);
}
if (failures.length) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `OK: ${expectedHosted.length} Hosted-, ${expectedLaunch.length} offene Launch-, ${expectedWebsite.length} Website-Aufgaben und ${Object.keys(root.bugs).length} Befunde; ${allUrls.size} eindeutige Issue-Links.`,
  );
  console.log("GitHub-Livezustand wird offline nicht überprüft.");
}
