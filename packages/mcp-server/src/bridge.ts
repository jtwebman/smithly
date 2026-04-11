import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isJSONRPCResultResponse, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MANIFEST_FILE_NAME = "smithly-mcp.json";
const RUNTIME_DIRECTORY_NAME = "runtime";
const PROJECT_ID_HEADER = "x-smithly-project-id";
const THREAD_ID_HEADER = "x-smithly-thread-id";
const BACKLOG_ITEM_ID_HEADER = "x-smithly-backlog-item-id";

interface ISmithlyMcpServiceManifest {
  readonly authToken: string;
  readonly endpointUrl: string;
}

export interface ISmithlyMcpBridgeConfig {
  readonly authToken: string;
  readonly backlogItemId?: string;
  readonly endpointUrl: string;
  readonly projectId: string;
  readonly threadId: string;
}

export interface ISmithlyMcpBridge {
  close(): Promise<void>;
}

interface ISmithlyMcpBridgeOptions {
  readonly httpTransport?: Transport;
  readonly stdioTransport?: Transport;
}

export function resolveSmithlyMcpBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ISmithlyMcpBridgeConfig {
  const manifestPath = resolveManifestPath(environment);
  const manifest = parseServiceManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);

  const projectId = environment.SMITHLY_PROJECT_ID?.trim();
  const threadId = environment.SMITHLY_THREAD_ID?.trim();
  const backlogItemId = environment.SMITHLY_BACKLOG_ITEM_ID?.trim();

  if (!projectId) {
    throw new Error("SMITHLY_PROJECT_ID is required for the Smithly MCP bridge.");
  }

  if (!threadId) {
    throw new Error("SMITHLY_THREAD_ID is required for the Smithly MCP bridge.");
  }

  return {
    authToken: manifest.authToken,
    ...(backlogItemId ? { backlogItemId } : {}),
    endpointUrl: manifest.endpointUrl,
    projectId,
    threadId,
  };
}

export function createSmithlyMcpBridgeHeaders(
  config: ISmithlyMcpBridgeConfig,
): Record<string, string> {
  return {
    authorization: `Bearer ${config.authToken}`,
    ...(config.backlogItemId !== undefined
      ? {
          [BACKLOG_ITEM_ID_HEADER]: config.backlogItemId,
        }
      : {}),
    [PROJECT_ID_HEADER]: config.projectId,
    [THREAD_ID_HEADER]: config.threadId,
  };
}

export async function startSmithlyMcpBridge(
  config: ISmithlyMcpBridgeConfig,
  options: ISmithlyMcpBridgeOptions = {},
): Promise<ISmithlyMcpBridge> {
  const stdioTransport =
    options.stdioTransport ?? (new StdioServerTransport() as Transport);
  const httpTransport =
    options.httpTransport ??
    (new StreamableHTTPClientTransport(new URL(config.endpointUrl), {
      requestInit: {
        headers: createSmithlyMcpBridgeHeaders(config),
      },
    }) as Transport);
  let isClosed = false;

  const close = async (): Promise<void> => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    await Promise.allSettled([httpTransport.close(), stdioTransport.close()]);
  };

  stdioTransport.onmessage = async (message) => {
    await httpTransport.send(message);
  };
  stdioTransport.onclose = () => {
    void close();
  };
  stdioTransport.onerror = (error) => {
    console.error(`Smithly MCP bridge stdio error: ${error.message}`);
  };

  httpTransport.onmessage = async (message) => {
    syncProtocolVersion(httpTransport, message);
    await stdioTransport.send(message);
  };
  httpTransport.onclose = () => {
    void close();
  };
  httpTransport.onerror = (error) => {
    console.error(`Smithly MCP bridge HTTP error: ${error.message}`);
  };

  await stdioTransport.start();

  return {
    close,
  };
}

function resolveManifestPath(environment: NodeJS.ProcessEnv): string {
  const explicitPath = environment.SMITHLY_MCP_MANIFEST_PATH?.trim();

  if (explicitPath) {
    return explicitPath;
  }

  const dataDirectory = environment.SMITHLY_DATA_DIRECTORY?.trim();

  if (!dataDirectory) {
    throw new Error(
      "Set SMITHLY_MCP_MANIFEST_PATH or SMITHLY_DATA_DIRECTORY for the Smithly MCP bridge.",
    );
  }

  return join(dataDirectory, RUNTIME_DIRECTORY_NAME, MANIFEST_FILE_NAME);
}

function parseServiceManifest(value: unknown): ISmithlyMcpServiceManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Smithly MCP manifest payload.");
  }

  const manifest = value as Record<string, unknown>;

  if (typeof manifest.authToken !== "string" || typeof manifest.endpointUrl !== "string") {
    throw new Error("Invalid Smithly MCP manifest payload.");
  }

  return {
    authToken: manifest.authToken,
    endpointUrl: manifest.endpointUrl,
  };
}

function syncProtocolVersion(transport: Transport, message: JSONRPCMessage): void {
  if (!isJSONRPCResultResponse(message) || transport.setProtocolVersion === undefined) {
    return;
  }

  const result = message.result;

  if (
    result !== null &&
    typeof result === "object" &&
    "protocolVersion" in result &&
    typeof result.protocolVersion === "string"
  ) {
    transport.setProtocolVersion(result.protocolVersion);
  }
}
