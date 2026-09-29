import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import type { Page } from 'playwright';
import { CommunityAdapter, type AdapterConfig } from './adapters.js';
import { BrowserPool } from './browser.js';
import { Store } from './store.js';
import { allowedUrl, fail, validatePost, type Job, type Platform, type Post, type Session } from './domain.js';

interface Prepared { page: Page; signature: string; adapter: CommunityAdapter; post: Post }
export class TripService {
  private prepared = new Map<string, Prepared>();
  private loginPages = new Map<string, Page>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly store: Store, readonly pool: BrowserPool, readonly config: AdapterConfig) {}
  adapter(platform: Platform) { return new CommunityAdapter(platform, this.config); }
  async serial<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const key = `${session.platform}-${session.account}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation); this.queues.set(key, next);
    try { return await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  async read<T>(session: Session, operation: (page: Page, adapter: CommunityAdapter) => Promise<T>) {
    return this.serial(session, async () => {
      const page = await this.pool.page(session);
      try { return await operation(page, this.adapter(session.platform)); } finally { await page.close(); }
    });
  }
  async login(session: Session) {
    if (this.pool.headless) fail('HEADLESS_LOGIN', '人工登录需要 TRIP_MCP_HEADLESS=false。');
    return this.serial(session, async () => {
      const key = `${session.platform}-${session.account}`;
      let page = this.loginPages.get(key);
      if (!page || page.isClosed()) { page = await this.pool.page(session); this.loginPages.set(key, page); }
      await this.adapter(session.platform).goto(page, this.adapter(session.platform).publishUrl);
      await page.bringToFront();
      return { status: 'awaiting_user', message: '请在本地浏览器登录，登录状态只保存在本机。完成后调用 check_login。', ...session };
    });
  }
  async checkLogin(session: Session) {
    return this.read(session, async (page, adapter) => { await adapter.goto(page, adapter.publishUrl); return adapter.loginStatus(page); });
  }
  async locations(session: Session, query: string) {
    return this.read(session, async (page, adapter) => {
      await adapter.goto(page, adapter.publishUrl); await adapter.requireLogin(page);
      return { candidates: await adapter.locations(page, query), instruction: '将所选候选的完整 label 传入 prepare_note.destination_option。' };
    });
  }
  async list(session: Session, url: string | undefined, keyword: string, limit: number, scrolls: number) {
    if (url) allowedUrl(url, session.platform);
    return this.read(session, (page, adapter) => adapter.list(page, url ?? adapter.myNotesUrl, keyword, limit, scrolls));
  }
  async detail(session: Session, url: string) { allowedUrl(url, session.platform); return this.read(session, (page, adapter) => adapter.detail(page, url)); }
  async prepare(input: Post): Promise<Job> {
    const { post, fingerprint } = await validatePost(input);
    return this.serial(post, async () => {
      // Acquire the process-level account lock before checking persistent idempotency records.
      await this.pool.context(post);
      const duplicate = await this.store.duplicate(fingerprint);
      if (duplicate) return { ...duplicate, message: '相同内容已有任务，未重复上传或提交。prepared 任务重启后需先 cancel_prepared_note 再准备。' };
      const now = new Date().toISOString();
      const job: Job = { id: randomUUID(), fingerprint, platform: post.platform, account: post.account, title: post.title, status: 'preparing', created_at: now, updated_at: now };
      await this.store.save(job);
      const page = await this.pool.page(post); const adapter = this.adapter(post.platform);
      try {
        const signature = await adapter.prepare(page, post);
        const screenshot = path.join(this.store.root, 'artifacts', job.id + '.png');
        await page.screenshot({ path: screenshot, fullPage: true }); await chmod(screenshot, 0o600);
        this.prepared.set(job.id, { page, signature, adapter, post });
        return this.store.update(job.id, { status: 'prepared', screenshot, message: '图片已上传并填写表单，尚未提交。请核对截图、账号、地点和正文，再调用 publish_note。' });
      } catch (error) {
        await this.store.update(job.id, { status: 'failed', message: '准备失败，未调用提交。' });
        // Keep the failed form visible until shutdown for diagnosis; do not silently navigate away.
        throw error;
      }
    });
  }
  async publish(id: string, confirm: boolean, acceptTerms: boolean): Promise<Job> {
    if (!confirm) fail('CONFIRMATION_REQUIRED', '请在用户确认目标账号及发布内容后设置 confirm=true。');
    const initial = await this.store.get(id);
    return this.serial(initial, async () => {
      const job = await this.store.get(id);
      if (job.status !== 'prepared') return { ...job, message: '此任务不是 prepared，未再次点击提交。请先核验已有结果。' };
      const prepared = this.prepared.get(id);
      if (!prepared || prepared.page.isClosed()) fail('PREPARATION_EXPIRED', '浏览器准备会话已失效。取消此 prepared 任务后重新准备；已提交任务不得这样重试。');
      if (job.platform === 'trip' && !acceptTerms) fail('TERMS_REQUIRED', 'Trip.com 要求确认素材归属和平台条款；请用户阅读并明确同意后设置 accept_terms=true。');
      await prepared.adapter.assertContent(prepared.page, prepared.post);
      if (await prepared.adapter.formSignature(prepared.page) !== prepared.signature) fail('FORM_CHANGED', '预览后页面内容被修改，请取消准备任务并重新生成预览。');
      // Write BEFORE the click: an interrupted connection must never lead to an automatic retry.
      await this.store.update(id, { status: 'submitting', message: '已进入提交阶段。' });
      try {
        await prepared.adapter.submit(prepared.page, acceptTerms);
        const evidence = await prepared.adapter.evidence(prepared.page);
        return await this.store.update(id, evidence);
      } catch {
        return this.store.update(id, { status: 'unknown', message: '提交阶段发生异常，结果未确认。请查看浏览器或 list_notes，禁止直接重复发布。' });
      }
    });
  }
  async status(id: string): Promise<Job> {
    const initial = await this.store.get(id);
    return this.serial(initial, async () => {
      const job = await this.store.get(id);
      const prepared = this.prepared.get(id);
      if (['submitting', 'unknown'].includes(job.status) && prepared && !prepared.page.isClosed()) {
        return this.store.update(id, await prepared.adapter.evidence(prepared.page));
      }
      if (job.status === 'submitting') return this.store.update(id, { status: 'unknown', message: '上次进程在提交阶段中断，请人工核对个人笔记列表。' });
      return job;
    });
  }
  async cancel(id: string) {
    const job = await this.store.get(id);
    return this.serial(job, async () => {
      const current = await this.store.get(id);
      if (!['preparing', 'prepared', 'failed'].includes(current.status)) fail('ALREADY_SUBMITTED', '已进入提交阶段的任务不能取消或重置；请核验结果。');
      await this.prepared.get(id)?.page.close(); this.prepared.delete(id);
      return this.store.update(id, { status: 'failed', message: '已取消本地准备任务，未删除平台内容。可以重新准备。' });
    });
  }
  async close() { await Promise.allSettled(this.queues.values()); await this.pool.close(); }
}
