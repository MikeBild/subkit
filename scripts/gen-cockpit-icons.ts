import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dir, "..");
const source = join(root, "apps/cockpit/public/favicon.svg");
for (const size of [192, 512]) {
  await sharp(source, { density: 300 })
    .resize(size, size, { fit: "contain", background: "#ffffff" })
    .png()
    .toFile(join(root, `apps/cockpit/public/app-icon-${size}.png`));
}
