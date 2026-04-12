import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function printUsage() {
  console.log(`Usage: node scripts/dev-desktop.mjs [--help] [--no-build]

Runs the desktop app with an isolated SMITHLY_DATA_DIRECTORY by default.
Set SMITHLY_DATA_DIRECTORY explicitly if you want to choose the dev data path yourself.
Use npm run dev:live only when you intentionally want the default live Smithly location.`);
}

const args = new Set(process.argv.slice(2));

if (args.has("--help")) {
  printUsage();
  process.exit(0);
}

const shouldBuild = !args.has("--no-build");
const providedDataDirectory = process.env.SMITHLY_DATA_DIRECTORY?.trim();
const tempDataDirectory =
  providedDataDirectory && providedDataDirectory.length > 0
    ? null
    : mkdtempSync(join(tmpdir(), "smithly-dev-data-"));

const environment = {
  ...process.env,
  ...(tempDataDirectory !== null ? { SMITHLY_DATA_DIRECTORY: tempDataDirectory } : {}),
};
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

if (tempDataDirectory !== null) {
  console.log(`[smithly] Using temporary data directory: ${tempDataDirectory}`);
} else {
  console.log(`[smithly] Using SMITHLY_DATA_DIRECTORY=${providedDataDirectory}`);
}

function runStep(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal === null
            ? `${command} ${commandArgs.join(" ")} exited with code ${code ?? "unknown"}`
            : `${command} ${commandArgs.join(" ")} exited from signal ${signal}`,
        ),
      );
    });
  });
}

try {
  if (shouldBuild) {
    await runStep(npmCommand, ["run", "build"]);
  }

  await runStep(npmCommand, ["--workspace", "@smithly/desktop", "start"]);
} finally {
  if (tempDataDirectory !== null) {
    rmSync(tempDataDirectory, { force: true, recursive: true });
  }
}
