import process from "node:process";

import { resolveSmithlyMcpBridgeConfig, startSmithlyMcpBridge } from "./bridge.ts";

async function main(): Promise<void> {
  const bridge = await startSmithlyMcpBridge(resolveSmithlyMcpBridgeConfig());

  const shutdown = () => {
    void bridge.close().finally(() => {
      process.exit(0);
    });
  };

  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : `Unknown Smithly MCP bridge error: ${String(error)}`,
  );
  process.exit(1);
});
