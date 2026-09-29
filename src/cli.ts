#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
import { BrowserPool } from './browser.js';
import { TripService } from './service.js';
import { createServer } from './server.js';
import { tripOrigin } from './domain.js';

async function main() {
  if (process.argv.includes('--help')) {
    console.log('trip-mcp: 本地 Ctrip / Trip Moments MCP (stdio)\n环境变量：TRIP_MCP_DATA_DIR, TRIP_MCP_HEADLESS, TRIP_MCP_TRIP_ORIGIN, TRIP_MCP_LOCALE\n安装浏览器：npx playwright install chromium\n文档：https://github.com/Bill666666/trip-mcp'); return;
  }
  if (process.argv.includes('--version')) { console.log('0.1.0'); return; }
  process.umask(0o077);
  const store = new Store(path.resolve(process.env.TRIP_MCP_DATA_DIR ?? path.join(homedir(), '.trip-mcp')));
  await store.init();
  const locale = process.env.TRIP_MCP_LOCALE ?? 'zh-HK';
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) throw new Error('Invalid locale');
  const pool = new BrowserPool(store, process.env.TRIP_MCP_HEADLESS === 'true');
  const service = new TripService(store, pool, { tripOrigin: tripOrigin(process.env.TRIP_MCP_TRIP_ORIGIN), locale });
  const server = createServer(service);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await service.close(); await server.close(); };
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.server.onclose = () => { void close(); };
}
main().catch(() => { console.error('trip-mcp 启动失败，请检查配置和目录权限。'); process.exitCode = 1; });
