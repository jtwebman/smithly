import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const desktopSourceDirectory = resolve("apps/desktop/src");
const desktopTargetDirectory = resolve("dist/apps/desktop/src");
const vendorTargetDirectory = resolve("dist/apps/desktop/src/vendor");

mkdirSync(desktopTargetDirectory, { recursive: true });
mkdirSync(vendorTargetDirectory, { recursive: true });

cpSync(
  resolve(desktopSourceDirectory, "index.html"),
  resolve(desktopTargetDirectory, "index.html"),
);
cpSync(
  resolve(desktopSourceDirectory, "preload.cjs"),
  resolve(desktopTargetDirectory, "preload.cjs"),
);
cpSync(
  resolve("node_modules/@xterm/xterm/css/xterm.css"),
  resolve(vendorTargetDirectory, "xterm.css"),
);
cpSync(
  resolve("node_modules/@xterm/xterm/lib/xterm.mjs"),
  resolve(vendorTargetDirectory, "xterm.mjs"),
);
cpSync(
  resolve("node_modules/@xterm/addon-fit/lib/addon-fit.mjs"),
  resolve(vendorTargetDirectory, "addon-fit.mjs"),
);
