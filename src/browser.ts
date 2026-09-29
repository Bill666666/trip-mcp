import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { fail, type Session } from './domain.js';
import { Store } from './store.js';

export class BrowserPool {
  private contexts = new Map<string, Promise<BrowserContext>>();
  private releases = new Map<string, () => Promise<void>>();
  constructor(readonly store: Store, readonly headless = false) {}
  async context(session: Session) {
    const key = `${session.platform}-${session.account}`;
    const existing = this.contexts.get(key); if (existing) return existing;
    const pending = (async () => {
      const release = await this.store.lock(session); this.releases.set(key, release);
      try {
        const context = await chromium.launchPersistentContext(path.join(this.store.root, 'profiles', key), {
          headless: this.headless, viewport: { width: 1440, height: 1000 },
          acceptDownloads: false, args: [],
        });
        context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(45000);
        return context;
      } catch {
        await release(); this.releases.delete(key); this.contexts.delete(key);
        fail('BROWSER_START_FAILED', '无法启动浏览器。请运行 npx playwright install chromium，并检查账号目录未被占用。');
      }
    })();
    this.contexts.set(key, pending); return pending;
  }
  async page(session: Session): Promise<Page> { return (await this.context(session)).newPage(); }
  async close() {
    for (const promise of this.contexts.values()) { const ctx = await promise.catch(() => undefined); await ctx?.close().catch(() => {}); }
    for (const release of this.releases.values()) await release();
    this.contexts.clear(); this.releases.clear();
  }
}
