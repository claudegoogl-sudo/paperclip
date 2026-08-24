import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PaperclipApiClient } from "./client.js";
import {
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  readConfigFromEnv,
  type PaperclipMcpConfig,
} from "./config.js";
import { withToolDeadline } from "./deadline.js";
import { createToolDefinitions } from "./tools.js";

export function createPaperclipMcpServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const server = new McpServer({
    name: "paperclip",
    version: "0.1.0",
  });

  const client = new PaperclipApiClient(config);
  const tools = createToolDefinitions(client);
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
  for (const tool of tools) {
    const guardedExecute = withToolDeadline(tool.name, tool.execute, toolTimeoutMs);
    server.tool(tool.name, tool.description, tool.schema.shape, guardedExecute);
  }

  return {
    server,
    tools,
    client,
  };
}

export async function runServer(config: PaperclipMcpConfig = readConfigFromEnv()) {
  const { server } = createPaperclipMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
