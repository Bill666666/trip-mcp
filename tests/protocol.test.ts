import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('真实 stdio MCP initialize、tools/list、tools/call 与错误返回', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-protocol-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js'], env: { ...process.env as Record<string, string>, TRIP_MCP_DATA_DIR: dir }, stderr: 'pipe' });
  const client = new Client({ name: 'trip-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    const capabilities = await client.callTool({ name: 'get_capabilities', arguments: {} });
    assert.equal(capabilities.isError, undefined);
    assert.match(JSON.stringify(capabilities), /local_browser/);
    const bad = await client.callTool({ name: 'get_note', arguments: { platform: 'trip', url: 'https://example.com/' } });
    assert.equal(bad.isError, true); assert.match(JSON.stringify(bad), /INVALID_URL/);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
