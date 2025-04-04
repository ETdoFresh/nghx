#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from 'node:path';
import fs from 'node:fs/promises';
import { parseGitHubUrl, getCacheDir, prepareRepository, runNpx } from './nghxUtils.js';

// Log to stderr to avoid interfering with MCP stdio communication
const logError = (...args: any[]) => console.error('[nghx-server-error]', ...args);
const logInfo = (...args: any[]) => console.error('[nghx-server-info]', ...args);

// --- Zod Schema for Input ---
const NghxInputSchema = z.object({
  github_url: z.string().url().describe("GitHub repository URL, optionally including branch and subpath (e.g., https://github.com/owner/repo/tree/branch/sub/path)"),
  args: z.array(z.string()).optional().default([]).describe("Additional arguments to pass to npx"),
});

// Infer the input type from the Zod schema
type NghxInput = z.infer<typeof NghxInputSchema>;

// --- Tool Handler ---
async function handleNghx(validatedArgs: NghxInput): Promise<CallToolResult> {
  logInfo("Handling run_github_npx request with args:", validatedArgs);

  try {
    const { github_url, args: npxArgs } = validatedArgs;

    // 1. Parse URL
    const { owner, repo, branch, subPath } = parseGitHubUrl(github_url);

    // 2. Get/Prepare Cache
    const cacheDir = getCacheDir();
    const repoDir = await prepareRepository(owner, repo, branch, cacheDir);

    // 3. Determine execution path (repo root or subpath)
    const executionPath = subPath ? path.join(repoDir, subPath) : repoDir;
    logInfo(`Final execution path: ${executionPath}`);

    // 4. Run NPX
    const { stdout, stderr, code } = await runNpx(executionPath, npxArgs, repoDir);

    // 5. Format and Return Result
    let resultText = '';
    if (stdout) resultText += `STDOUT:\n${stdout.trim()}\n`;
    if (stderr) resultText += `STDERR:\n${stderr.trim()}\n`;
    if (resultText === '') resultText = 'npx command completed with no output.';
    resultText += `\nExit Code: ${code}`;

    return {
      content: [{ type: "text", text: resultText }],
      isError: code !== 0
    };

  } catch (error: any) {
    logError(`Error in run_github_npx handler: ${error.message}`, error.stack);
    return {
      content: [{ type: "text", text: `<error>${error.message}</error>` }],
      isError: true,
    };
  }
}

// --- Server Setup ---
const server = new McpServer(
  {
    name: "nghx-mcp-server",
    version: "1.0.0",
  }
);

// Register the tool using server.tool()
server.tool(
    "run_github_npx",
    "Clones or updates a GitHub repository to a local cache, installs dependencies if needed, and runs npx within the specified path.",
    NghxInputSchema.shape,
    handleNghx
);

// --- Start Server ---
async function runServer() {
  try {
      const cacheDir = getCacheDir();
      await fs.mkdir(cacheDir, { recursive: true });

      const transport = new StdioServerTransport();
      await server.connect(transport);
      logInfo("NGHX MCP Server running on stdio");
  } catch (error) {
      logError("Failed to initialize server:", error);
      process.exit(1);
  }
}

runServer().catch((error) => {
  logError("Fatal error running server:", error);
  process.exit(1);
}); 