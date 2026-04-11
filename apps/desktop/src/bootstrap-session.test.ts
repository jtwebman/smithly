import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import { createContext } from "@smithly/storage";

import { BootstrapSessionManager } from "./bootstrap-session.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("bootstrap session manager", () => {
  it("starts Claude with the live Smithly MCP bridge config", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-bootstrap-session-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
        workers: {
          claude: {
            args: ["--dangerously-skip-permissions"],
            command: "claude",
          },
          codex: {
            args: [],
            command: "codex",
          },
        },
      }),
    });
    const spawnedCalls: Array<{
      readonly args: readonly string[];
      readonly command: string;
      readonly env: NodeJS.ProcessEnv;
    }> = [];
    let onData: ((value: string) => void) | undefined;
    let onExit: ((value: { exitCode: number }) => void) | undefined;
    const manager = new BootstrapSessionManager(
      context,
      () => undefined,
      () => undefined,
      {
        spawnPty: ((command: string, args: string[], options: IPtyForkOptions) => {
          spawnedCalls.push({
            args,
            command,
            env: options.env ?? {},
          });

          return {
            kill: () => {
              onExit?.({
                exitCode: 0,
              });
            },
            onData: (listener: (value: string) => void) => {
              onData = listener;
            },
            onExit: (listener: (value: { exitCode: number }) => void) => {
              onExit = listener;
            },
            resize: () => undefined,
            write: () => undefined,
          } as unknown as IPty;
        }) as typeof import("node-pty").spawn,
      },
    );

    manager.ensureSession();

    expect(spawnedCalls).toHaveLength(1);

    const spawnedCall = spawnedCalls[0];

    expect(spawnedCall).toBeDefined();

    if (spawnedCall === undefined) {
      throw new Error("Bootstrap session did not spawn a worker.");
    }

    const mcpConfigArgumentIndex = spawnedCall.args.findIndex((value) => value === "--mcp-config");
    const mcpConfig =
      mcpConfigArgumentIndex === -1
        ? undefined
        : JSON.parse(spawnedCall.args[mcpConfigArgumentIndex + 1] ?? "null");

    expect(spawnedCall.command).toBe("claude");
    expect(spawnedCall.args).toContain("--strict-mcp-config");
    expect(mcpConfig).toMatchObject({
      mcpServers: {
        smithly: {
          args: [expect.stringContaining("packages/mcp-server/src/bridge-main.js")],
          command: "node",
          env: {
            SMITHLY_ATTACH_SCOPE: "global",
            SMITHLY_DATA_DIRECTORY: dataDirectory,
          },
        },
      },
    });
    expect(spawnedCall.env.SMITHLY_BOOTSTRAP_SESSION).toBe("1");
    expect(JSON.parse(spawnedCall.env.SMITHLY_MCP_CONFIG_JSON ?? "null")).toEqual(mcpConfig);
    expect(onData).toBeTypeOf("function");
    expect(onExit).toBeTypeOf("function");

    manager.dispose();
    context.db.close();
  });
});
import type { IPty, IPtyForkOptions } from "node-pty";
