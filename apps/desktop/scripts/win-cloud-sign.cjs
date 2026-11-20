const { execFileSync } = require("node:child_process");

function serviceEnvironment(raw) {
  const values = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return values;
}

function sign(configuration) {
  const tool = process.env.WIN_CLOUD_SIGN_TOOL;
  if (!tool) throw new Error("WIN_CLOUD_SIGN_TOOL names no signing tool");
  const template = JSON.parse(process.env.WIN_CLOUD_SIGN_ARGS ?? "null");
  if (
    !Array.isArray(template) ||
    !template.every((part) => typeof part === "string") ||
    !template.some((part) => part.includes("{file}"))
  )
    throw new Error("WIN_CLOUD_SIGN_ARGS must be a JSON list of arguments that contains {file}");
  execFileSync(
    tool,
    template.map((part) => part.replaceAll("{file}", configuration.path)),
    {
      stdio: "inherit",
      env: { ...process.env, ...serviceEnvironment(process.env.WIN_CLOUD_SIGN_ENV) },
    },
  );
}

module.exports = sign;
module.exports.default = sign;
