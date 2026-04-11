import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createConfig } from "@smithly/core";
import { createContext, seedInitialState } from "@smithly/storage";

import { createSmithlyMcpServer } from "./index.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directoryPath of temporaryDirectories.splice(0)) {
    rmSync(directoryPath, { force: true, recursive: true });
  }
});

describe("smithly mcp server", () => {
  it("creates draft backlog items from the project planning thread", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.projectChatThread.id,
    });
    const client = new Client({
      name: "smithly-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      arguments: {
        scopeSummary: "Create backlog drafts directly from project planning.",
        title: "Create backlog draft through MCP",
      },
      name: "create_draft_backlog_item",
    });

    expect(result.structuredContent).toMatchObject({
      status: "draft",
      title: "Create backlog draft through MCP",
    });

    await Promise.all([clientTransport.close(), serverTransport.close()]);
    context.db.close();
  });

  it("revises the focused backlog item and exposes project resources", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "smithly-mcp-"));

    temporaryDirectories.push(dataDirectory);

    const context = createContext({
      config: createConfig({
        dataDirectory,
      }),
    });
    const fixture = seedInitialState(context);
    const server = createSmithlyMcpServer(context, {
      backlogItemId: fixture.backlogItem.id,
      dataDirectory,
      projectId: fixture.project.id,
      threadId: fixture.taskChatThread.id,
    });
    const client = new Client({
      name: "smithly-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resource = await client.readResource({
      uri: "smithly://project/current",
    });
    const reviseResult = await client.callTool({
      arguments: {
        acceptanceCriteria: [
          "Claude can revise the task scope through MCP",
          "Acceptance criteria are persisted in SQLite",
        ],
        noteText: "Track the first revision path through the task planning thread.",
        priority: 95,
        reviewMode: "ai",
        riskLevel: "high",
        scopeSummary: "Revise the selected backlog item through Smithly MCP.",
        status: "approved",
      },
      name: "revise_backlog_item",
    });

    const firstContent = resource.contents[0];

    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      '"name": "Smithly"',
    );
    expect(firstContent && "text" in firstContent ? firstContent.text : "").toContain(
      '"riskLevel": "medium"',
    );
    expect(reviseResult.structuredContent).toMatchObject({
      acceptanceCriteriaCount: 2,
      backlogItemId: fixture.backlogItem.id,
      priority: 95,
      reviewMode: "ai",
      riskLevel: "high",
      status: "approved",
      title: "Bootstrap the desktop shell",
    });

    await Promise.all([clientTransport.close(), serverTransport.close()]);
    context.db.close();
  });
});
