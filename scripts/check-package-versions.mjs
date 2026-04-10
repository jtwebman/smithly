import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT_DIRECTORY = process.cwd();
const IGNORED_DIRECTORIES = new Set([".git", "coverage", "dist", "node_modules"]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const EXACT_VERSION_PATTERN =
  /^(?:\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|workspace:[^~^*<>]+|file:.+|https?:.+|git\+.+|github:.+)$/u;

const packageJsonPaths = findPackageJsonPaths(ROOT_DIRECTORY);
const violations = [];

for (const packageJsonPath of packageJsonPaths) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

  for (const fieldName of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[fieldName];

    if (dependencies === undefined || typeof dependencies !== "object") {
      continue;
    }

    for (const [packageName, version] of Object.entries(dependencies)) {
      if (typeof version !== "string") {
        violations.push(
          `${relative(ROOT_DIRECTORY, packageJsonPath)}: ${fieldName}.${packageName} must be a string`,
        );
        continue;
      }

      if (!EXACT_VERSION_PATTERN.test(version)) {
        violations.push(
          `${relative(ROOT_DIRECTORY, packageJsonPath)}: ${fieldName}.${packageName} must be pinned exactly, found "${version}"`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Non-pinned package versions found:");

  for (const violation of violations) {
    console.error(`- ${violation}`);
  }

  process.exitCode = 1;
}

function findPackageJsonPaths(directoryPath) {
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const paths = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      paths.push(...findPackageJsonPaths(join(directoryPath, entry.name)));
      continue;
    }

    if (entry.name !== "package.json") {
      continue;
    }

    const packageJsonPath = resolve(directoryPath, entry.name);

    if (!statSync(packageJsonPath).isFile()) {
      continue;
    }

    paths.push(packageJsonPath);
  }

  return paths.sort();
}
