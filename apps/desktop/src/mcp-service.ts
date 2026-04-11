import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  createSmithlyMcpContext,
  createSmithlyMcpServer,
  type ISmithlyMcpEnvironment,
} from "@smithly/mcp-server";
import { getBacklogItemById, listChatThreadsForProject, upsertChatThread } from "@smithly/storage";

const MCP_ROUTE_PATH = "/mcp";
const HEALTH_ROUTE_PATH = "/health";
const RUNTIME_DIRECTORY_NAME = "runtime";
const MANIFEST_FILE_NAME = "smithly-mcp.json";
const AUTHORIZATION_SCHEME = "Bearer";
const ATTACH_SCOPE_HEADER = "x-smithly-attach-scope";
const PROJECT_ID_HEADER = "x-smithly-project-id";
const THREAD_ID_HEADER = "x-smithly-thread-id";
const BACKLOG_ITEM_ID_HEADER = "x-smithly-backlog-item-id";

export interface ISmithlyMcpServiceManifest {
  readonly authToken: string;
  readonly endpointUrl: string;
  readonly manifestPath: string;
  readonly pid: number;
  readonly startedAt: string;
}

interface ISessionRecord {
  readonly context: ReturnType<typeof createSmithlyMcpContext>;
  readonly server: ReturnType<typeof createSmithlyMcpServer>;
  readonly transport: StreamableHTTPServerTransport;
}

export class SmithlyMcpService {
  private readonly sessions = new Map<string, ISessionRecord>();
  private readonly authToken = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly runtimeDirectoryPath: string;
  private readonly manifestPath: string;
  private server: Server | null = null;
  private manifest: ISmithlyMcpServiceManifest | null = null;

  public constructor(private readonly dataDirectory: string) {
    this.runtimeDirectoryPath = join(dataDirectory, RUNTIME_DIRECTORY_NAME);
    this.manifestPath = join(this.runtimeDirectoryPath, MANIFEST_FILE_NAME);
  }

  public async start(): Promise<ISmithlyMcpServiceManifest> {
    if (this.manifest !== null) {
      return this.manifest;
    }

    mkdirSync(this.runtimeDirectoryPath, { recursive: true });

    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        this.writeJson(
          response,
          500,
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Unable to resolve the Smithly MCP service address.");
    }

    this.manifest = {
      authToken: this.authToken,
      endpointUrl: `http://127.0.0.1:${address.port}${MCP_ROUTE_PATH}`,
      manifestPath: this.manifestPath,
      pid: process.pid,
      startedAt: this.startedAt,
    };
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));

    return this.manifest;
  }

  public async stop(): Promise<void> {
    const closeOperations = [...this.sessions.keys()].map(async (sessionId) => {
      await this.closeSession(sessionId);
    });

    await Promise.all(closeOperations);

    if (this.server !== null) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      this.server = null;
    }

    rmSync(this.manifestPath, { force: true });
    this.manifest = null;
  }

  public getManifest(): ISmithlyMcpServiceManifest | null {
    return this.manifest;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === HEALTH_ROUTE_PATH && request.method === "GET") {
      this.writeJson(response, 200, {
        endpointUrl: this.manifest?.endpointUrl ?? null,
        pid: process.pid,
        startedAt: this.startedAt,
        status: "ok",
      });
      return;
    }

    if (!this.isAuthorized(request)) {
      this.writeJson(response, 401, {
        error: "Unauthorized Smithly MCP request.",
      });
      return;
    }

    if (request.url !== MCP_ROUTE_PATH) {
      this.writeJson(response, 404, {
        error: "Not found.",
      });
      return;
    }

    if (request.method === "DELETE") {
      const sessionId = this.readSessionId(request);

      if (sessionId === undefined || !this.sessions.has(sessionId)) {
        this.writeJson(response, 404, {
          error: "Unknown Smithly MCP session.",
        });
        return;
      }

      await this.closeSession(sessionId);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET") {
      const sessionId = this.readSessionId(request);

      if (sessionId === undefined) {
        this.writeJson(response, 400, {
          error: "MCP session id is required.",
        });
        return;
      }

      const session = this.sessions.get(sessionId);

      if (session === undefined) {
        this.writeJson(response, 404, {
          error: "Unknown Smithly MCP session.",
        });
        return;
      }

      await session.transport.handleRequest(request, response);
      return;
    }

    if (request.method === "POST") {
      const parsedBody = await this.readRequestJson(request);
      const sessionId = this.readSessionId(request);

      if (sessionId !== undefined) {
        const session = this.sessions.get(sessionId);

        if (session === undefined) {
          this.writeJson(response, 404, {
            error: "Unknown Smithly MCP session.",
          });
          return;
        }

        await session.transport.handleRequest(request, response, parsedBody);
        return;
      }

      if (!isInitializeRequest(parsedBody)) {
        this.writeJson(response, 400, {
          error: "A new Smithly MCP session must begin with initialize.",
        });
        return;
      }

      const environment = this.readEnvironmentFromRequest(request);
      const context = createSmithlyMcpContext(environment);
      const server = createSmithlyMcpServer(context, environment);
      let createdSessionId = "";
      const transport = new StreamableHTTPServerTransport({
        onsessioninitialized(sessionIdValue) {
          createdSessionId = sessionIdValue;
        },
        sessionIdGenerator: () => randomUUID(),
      });

      await server.connect(transport as Transport);

      try {
        await transport.handleRequest(request, response, parsedBody);
      } catch (error) {
        context.db.close();
        throw error;
      }

      if (createdSessionId.length === 0) {
        context.db.close();
        throw new Error("Smithly MCP session initialization did not return a session id.");
      }

      this.sessions.set(createdSessionId, {
        context,
        server,
        transport,
      });
      return;
    }

    response.setHeader("Allow", "DELETE, GET, POST");
    this.writeJson(response, 405, {
      error: "Method not allowed.",
    });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const headerValue = request.headers.authorization?.trim();

    return headerValue === `${AUTHORIZATION_SCHEME} ${this.authToken}`;
  }

  private readEnvironmentFromRequest(request: IncomingMessage): ISmithlyMcpEnvironment {
    const attachScope = this.readAttachScope(request);
    const projectId = readSingleHeader(request, PROJECT_ID_HEADER);
    const threadId = readSingleHeader(request, THREAD_ID_HEADER);
    const backlogItemId = readSingleHeader(request, BACKLOG_ITEM_ID_HEADER);

    if (attachScope === "global") {
      return {
        attachScope,
        dataDirectory: this.dataDirectory,
      };
    }

    if (!projectId) {
      throw new Error(`Missing ${PROJECT_ID_HEADER} header.`);
    }

    const resolvedThreadId =
      threadId ?? this.ensureAttachThread(attachScope, projectId, backlogItemId);

    return {
      attachScope,
      ...(backlogItemId ? { backlogItemId } : {}),
      dataDirectory: this.dataDirectory,
      projectId,
      threadId: resolvedThreadId,
    };
  }

  private readAttachScope(request: IncomingMessage): ISmithlyMcpEnvironment["attachScope"] {
    const attachScope = readSingleHeader(request, ATTACH_SCOPE_HEADER);

    switch (attachScope) {
      case "global":
      case "project":
      case "backlog_item":
        return attachScope;
      default:
        return readSingleHeader(request, BACKLOG_ITEM_ID_HEADER) ? "backlog_item" : "project";
    }
  }

  private readSessionId(request: IncomingMessage): string | undefined {
    const sessionIdHeader = request.headers["mcp-session-id"];

    if (Array.isArray(sessionIdHeader)) {
      return sessionIdHeader[0]?.trim() || undefined;
    }

    return sessionIdHeader?.trim() || undefined;
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (session === undefined) {
      return;
    }

    this.sessions.delete(sessionId);
    await session.transport.close();
    session.context.db.close();
  }

  private async readRequestJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const bodyText = Buffer.concat(chunks).toString("utf8").trim();

    if (bodyText.length === 0) {
      return undefined;
    }

    return JSON.parse(bodyText) as unknown;
  }

  private writeJson(response: ServerResponse, statusCode: number, payload: object): void {
    if (response.headersSent) {
      return;
    }

    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  }

  private ensureAttachThread(
    attachScope: Exclude<ISmithlyMcpEnvironment["attachScope"], "global">,
    projectId: string,
    backlogItemId?: string,
  ): string {
    const context = createSmithlyMcpContext({
      attachScope,
      ...(backlogItemId !== undefined ? { backlogItemId } : {}),
      dataDirectory: this.dataDirectory,
      projectId,
    });

    try {
      const existingThread = listChatThreadsForProject(context, projectId).find((thread) => {
        if (attachScope === "backlog_item") {
          return thread.kind === "task_planning" && thread.backlogItemId === backlogItemId;
        }

        return thread.kind === "project_planning";
      });

      if (existingThread !== undefined) {
        return existingThread.id;
      }

      const createdAt = new Date().toISOString();

      if (attachScope === "project") {
        const threadId = `thread-project-${randomUUID()}`;

        upsertChatThread(context, {
          createdAt,
          id: threadId,
          kind: "project_planning",
          projectId,
          status: "open",
          title: "External MCP project attach",
          updatedAt: createdAt,
        });

        return threadId;
      }

      if (backlogItemId === undefined) {
        throw new Error(`Missing ${BACKLOG_ITEM_ID_HEADER} header.`);
      }

      const backlogItem = getBacklogItemById(context, backlogItemId);

      if (backlogItem === null || backlogItem.projectId !== projectId) {
        throw new Error(`Missing backlog item ${backlogItemId} on project ${projectId}.`);
      }

      const threadId = `thread-task-${randomUUID()}`;

      upsertChatThread(context, {
        backlogItemId,
        createdAt,
        id: threadId,
        kind: "task_planning",
        projectId,
        status: "open",
        title: `${backlogItem.title} external MCP attach`,
        updatedAt: createdAt,
      });

      return threadId;
    } finally {
      context.db.close();
    }
  }
}

function readSingleHeader(request: IncomingMessage, headerName: string): string | undefined {
  const headerValue = request.headers[headerName];

  if (Array.isArray(headerValue)) {
    return headerValue[0]?.trim() || undefined;
  }

  return headerValue?.trim() || undefined;
}
