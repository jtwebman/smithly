import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import { createContext, seedInitialState } from "@smithly/storage";

import { SmithlyMcpService } from "../../../apps/desktop/src/mcp-service.ts";
import { resolveSmithlyMcpBridgeConfig, startSmithlyMcpBridge } from "./bridge.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("smithly mcp stdio bridge", () => {
  it("attaches an external stdio client to the live Smithly MCP service", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bridge-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const service = new SmithlyMcpService(dataDirectory);
    const manifest = await service.start();
    const bridgeInput = new PassThrough();
    const bridgeOutput = new PassThrough();
    const bridge = await startSmithlyMcpBridge(
      resolveSmithlyMcpBridgeConfig({
        SMITHLY_DATA_DIRECTORY: dataDirectory,
        SMITHLY_PROJECT_ID: fixture.project.id,
        SMITHLY_THREAD_ID: fixture.projectChatThread.id,
      }),
      {
        stdioTransport: new StdioServerTransport(bridgeInput, bridgeOutput) as Transport,
      },
    );
    const client = new Client({
      name: "smithly-bridge-test-client",
      version: "0.1.0",
    });

    await client.connect(new StdioServerTransport(bridgeOutput, bridgeInput) as Transport);

    const toolResult = await client.callTool({
      name: "get_project_snapshot",
    });

    expect(manifest.endpointUrl).toContain("/mcp");
    expect(toolResult.structuredContent).toMatchObject({
      backlogCount: 1,
      memoryNoteCount: 1,
      planningThreadCount: 2,
      projectId: fixture.project.id,
      projectName: fixture.project.name,
    });

    await client.close();
    await bridge.close();
    await service.stop();
    context.db.close();
  });
});
