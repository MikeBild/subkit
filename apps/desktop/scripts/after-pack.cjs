const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function renameHelper(plist, productName) {
  const name = productName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return plist.replace(
    /(<key>CFBundleName<\/key>\s*<string>)Electron( Helper[^<]*<\/string>)/,
    (_match, head, tail) => `${head}${name}${tail}`,
  );
}

function afterPack(context) {
  if (context.electronPlatformName !== "darwin" && context.electronPlatformName !== "mas") return;
  const { productName, productFilename } = context.packager.appInfo;
  const frameworks = join(context.appOutDir, `${productFilename}.app`, "Contents", "Frameworks");
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith(".app")) continue;
    const file = join(frameworks, entry, "Contents", "Info.plist");
    const plist = readFileSync(file, "utf8");
    const renamed = renameHelper(plist, productName);
    if (renamed !== plist) writeFileSync(file, renamed);
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.renameHelper = renameHelper;
