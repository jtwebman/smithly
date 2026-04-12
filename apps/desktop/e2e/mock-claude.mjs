import readline from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scope = process.env.SMITHLY_THREAD_KIND === "task_planning" ? "task" : "project";
const backlogItemId = process.env.SMITHLY_BACKLOG_ITEM_ID;
const mcpConfig = JSON.parse(process.env.SMITHLY_MCP_CONFIG_JSON ?? "{}");
const serverConfig = mcpConfig.mcpServers?.smithly;
let clientPromise;

console.log(`mock claude ready for ${scope} planning`);

if (backlogItemId) {
  console.log(`focused backlog item: ${backlogItemId}`);
}

const reader = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

reader.on("line", async (line) => {
  const prompt = line.trim();

  if (prompt.length === 0) {
    return;
  }

  if (prompt === "/exit") {
    console.log("mock claude exiting");
    process.exit(0);
  }

  if (prompt.startsWith("/pause")) {
    console.log(`mock claude pausing: ${prompt.slice("/pause".length).trim() || "requested"}`);
    process.exit(0);
  }

  if (prompt.startsWith("create draft:")) {
    const [titlePart, scopePart] = prompt
      .slice("create draft:".length)
      .split("|")
      .map((part) => {
        return part.trim();
      });

    if (!titlePart || !scopePart) {
      console.log("claude error: create draft format is 'create draft: Title | Scope summary'");
      return;
    }

    const client = await getClient();
    const result = await client.callTool({
      arguments: {
        scopeSummary: scopePart,
        title: titlePart,
      },
      name: "create_draft_backlog_item",
    });

    console.log(`claude tool create_draft_backlog_item: ${result.content[0]?.text ?? "ok"}`);
    return;
  }

  if (prompt.startsWith("remove backlog:")) {
    const [backlogItemId, notePart] = prompt
      .slice("remove backlog:".length)
      .split("|")
      .map((part) => {
        return part.trim();
      });

    if (!backlogItemId) {
      console.log(
        "claude error: remove backlog format is 'remove backlog: backlog-id | Optional note'",
      );
      return;
    }

    const client = await getClient();
    const result = await client.callTool({
      arguments: {
        backlogItemId,
        ...(notePart ? { noteText: notePart } : {}),
      },
      name: "remove_pending_backlog_item",
    });

    console.log(`claude tool remove_pending_backlog_item: ${result.content[0]?.text ?? "ok"}`);
    return;
  }

  if (prompt.startsWith("revise task:")) {
    const [
      scopeSummary,
      criteriaPart,
      notePart,
      statusPart,
      priorityPart,
      riskLevelPart,
      reviewModePart,
    ] = prompt
      .slice("revise task:".length)
      .split("|")
      .map((part) => {
        return part.trim();
      });

    if (!scopeSummary || !criteriaPart) {
      console.log(
        "claude error: revise task format is 'revise task: Scope summary | Criterion A; Criterion B | Optional note'",
      );
      return;
    }

    const acceptanceCriteria = criteriaPart
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const client = await getClient();
    const result = await client.callTool({
      arguments: {
        acceptanceCriteria,
        ...(notePart ? { noteText: notePart } : {}),
        ...(statusPart ? { status: statusPart } : {}),
        ...(priorityPart ? { priority: Number(priorityPart) } : {}),
        ...(riskLevelPart ? { riskLevel: riskLevelPart } : {}),
        ...(reviewModePart ? { reviewMode: reviewModePart } : {}),
        scopeSummary,
      },
      name: "revise_backlog_item",
    });

    console.log(`claude tool revise_backlog_item: ${result.content[0]?.text ?? "ok"}`);
    return;
  }

  if (prompt.startsWith("reprioritize backlog:")) {
    const [backlogItemId, priorityPart, notePart] = prompt
      .slice("reprioritize backlog:".length)
      .split("|")
      .map((part) => {
        return part.trim();
      });

    if (!backlogItemId || !priorityPart) {
      console.log(
        "claude error: reprioritize format is 'reprioritize backlog: backlog-id | priority | Optional note'",
      );
      return;
    }

    const client = await getClient();
    const result = await client.callTool({
      arguments: {
        backlogItemId,
        ...(notePart ? { noteText: notePart } : {}),
        priority: Number(priorityPart),
      },
      name: "reprioritize_backlog_item",
    });

    console.log(`claude tool reprioritize_backlog_item: ${result.content[0]?.text ?? "ok"}`);
    return;
  }

  if (prompt.startsWith("reorder pending:")) {
    const [idsPart, notePart] = prompt
      .slice("reorder pending:".length)
      .split("|")
      .map((part) => {
        return part.trim();
      });

    if (!idsPart) {
      console.log(
        "claude error: reorder format is 'reorder pending: backlog-a ; backlog-b | Optional note'",
      );
      return;
    }

    const backlogItemIds = idsPart
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const client = await getClient();
    const result = await client.callTool({
      arguments: {
        backlogItemIds,
        ...(notePart ? { noteText: notePart } : {}),
      },
      name: "reorder_pending_backlog_items",
    });

    console.log(`claude tool reorder_pending_backlog_items: ${result.content[0]?.text ?? "ok"}`);
    return;
  }

  if (prompt.startsWith("hook approval:")) {
    const [title, detail, status = "pending"] = prompt
      .slice("hook approval:".length)
      .split("|")
      .map((part) => part.trim());

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          detail,
          requestedBy: "claude",
          status,
          title,
        },
        type: "approval_request",
      })}`,
    );
    return;
  }

  if (prompt.startsWith("hook blocker:")) {
    const [title, detail, blockerType = "human", status = "open"] = prompt
      .slice("hook blocker:".length)
      .split("|")
      .map((part) => part.trim());

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          blockerType,
          detail,
          status,
          title,
        },
        type: "blocker",
      })}`,
    );
    return;
  }

  if (prompt.startsWith("hook note:")) {
    const [title, bodyText, noteType = "note"] = prompt
      .slice("hook note:".length)
      .split("|")
      .map((part) => part.trim());

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          bodyText,
          noteType,
          title,
        },
        type: "memory_note",
      })}`,
    );
    return;
  }

  if (prompt.startsWith("hook task:")) {
    const [id, status, summaryText] = prompt
      .slice("hook task:".length)
      .split("|")
      .map((part) => part.trim());

    console.log(
      `smithly-hook: ${JSON.stringify({
        payload: {
          id,
          status,
          summaryText,
        },
        type: "task_outcome",
      })}`,
    );
    return;
  }

  console.log(`claude ack: ${prompt}`);
});

async function getClient() {
  if (clientPromise) {
    return clientPromise;
  }

  if (!serverConfig) {
    throw new Error("Missing Smithly MCP server config.");
  }

  clientPromise = (async () => {
    const client = new Client({
      name: "smithly-mock-claude",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport(serverConfig);

    await client.connect(transport);
    return client;
  })();

  return clientPromise;
}
