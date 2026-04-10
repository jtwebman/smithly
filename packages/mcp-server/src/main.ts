import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createSmithlyMcpContext,
  createSmithlyMcpServer,
  resolveSmithlyMcpEnvironment,
} from "./index.ts";

async function main(): Promise<void> {
  const environment = resolveSmithlyMcpEnvironment();
  const context = createSmithlyMcpContext(environment);
  const server = createSmithlyMcpServer(context, environment);
  const transport = new StdioServerTransport();

  process.on("exit", () => {
    context.db.close();
  });

  await server.connect(transport);
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : `Unknown Smithly MCP server error: ${String(error)}`,
  );
  process.exit(1);
});
