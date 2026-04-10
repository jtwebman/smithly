import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const sourceDirectory = resolve("packages/storage/migrations");
const targetDirectory = resolve("dist/packages/storage/migrations");

if (existsSync(sourceDirectory)) {
  mkdirSync(dirname(targetDirectory), { recursive: true });
  cpSync(sourceDirectory, targetDirectory, { recursive: true });
}
