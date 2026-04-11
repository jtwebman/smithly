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
  it("attaches an external stdio client to the live Smithly MCP service with project scope", async () => {
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

  it("creates safe backlog-item attach context when an external client scopes to one backlog item", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bridge-backlog-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const service = new SmithlyMcpService(dataDirectory);

    await service.start();

    const bridgeInput = new PassThrough();
    const bridgeOutput = new PassThrough();
    const bridge = await startSmithlyMcpBridge(
      resolveSmithlyMcpBridgeConfig({
        SMITHLY_ATTACH_SCOPE: "backlog_item",
        SMITHLY_BACKLOG_ITEM_ID: fixture.backlogItem.id,
        SMITHLY_DATA_DIRECTORY: dataDirectory,
        SMITHLY_PROJECT_ID: fixture.project.id,
      }),
      {
        stdioTransport: new StdioServerTransport(bridgeInput, bridgeOutput) as Transport,
      },
    );
    const client = new Client({
      name: "smithly-bridge-backlog-client",
      version: "0.1.0",
    });

    await client.connect(new StdioServerTransport(bridgeOutput, bridgeInput) as Transport);

    const resource = await client.readResource({
      uri: "smithly://backlog/current",
    });
    const reviseResult = await client.callTool({
      arguments: {
        acceptanceCriteria: [
          "External backlog attach keeps the selected backlog item focused",
          "A safe planning thread is created automatically when needed",
        ],
        scopeSummary: "Revise the attached backlog item through the external MCP bridge.",
      },
      name: "revise_backlog_item",
    });
    const firstContent = resource.contents[0];

    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      fixture.backlogItem.id,
    );
    expect(reviseResult.structuredContent).toMatchObject({
      acceptanceCriteriaCount: 2,
      backlogItemId: fixture.backlogItem.id,
    });

    await client.close();
    await bridge.close();
    await service.stop();
    context.db.close();
  });

  it("supports global attach scope before any project is selected", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-bridge-global-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });

    const fixture = seedInitialState(context);

    const service = new SmithlyMcpService(dataDirectory);

    await service.start();

    const bridgeInput = new PassThrough();
    const bridgeOutput = new PassThrough();
    const bridge = await startSmithlyMcpBridge(
      resolveSmithlyMcpBridgeConfig({
        SMITHLY_ATTACH_SCOPE: "global",
        SMITHLY_DATA_DIRECTORY: dataDirectory,
      }),
      {
        stdioTransport: new StdioServerTransport(bridgeInput, bridgeOutput) as Transport,
      },
    );
    const client = new Client({
      name: "smithly-bridge-global-client",
      version: "0.1.0",
    });

    await client.connect(new StdioServerTransport(bridgeOutput, bridgeInput) as Transport);

    const resource = await client.readResource({
      uri: "smithly://attach/current",
    });
    const listResult = await client.callTool({
      name: "list_projects",
    });
    const projectResult = await client.callTool({
      arguments: {
        projectId: fixture.project.id,
      },
      name: "get_project_by_id",
    });
    const firstContent = resource.contents[0];

    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      '"attachScope": "global"',
    );
    expect(listResult.structuredContent).toMatchObject({
      projects: [
        expect.objectContaining({
          id: fixture.project.id,
          name: fixture.project.name,
        }),
      ],
    });
    expect(projectResult.structuredContent).toMatchObject({
      project: expect.objectContaining({
        id: fixture.project.id,
        name: fixture.project.name,
      }),
    });

    await client.close();
    await bridge.close();
    await service.stop();
    context.db.close();
  });
});
