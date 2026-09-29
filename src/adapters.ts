import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { allowedUrl, fail, noteId, renderedContent, type Evidence, type Platform, type Post } from './domain.js';

export interface Note { title: string; url?: string; note_id?: string; excerpt?: string }
export interface AdapterConfig { tripOrigin: string; locale: string }

async function uniqueVisible(locators: Locator[], label: string): Promise<Locator> {
  for (const candidate of locators) {
    const visible = candidate.filter({ visible: true });
    if (await visible.count() === 1) return visible;
  }
  fail('PAGE_CHANGED', `无法唯一定位${label}；请保留页面并核对网站结构。`);
}
export async function poll<T>(fn: () => Promise<T | undefined>, ms = 15000): Promise<T | undefined> {
  const end = Date.now() + ms;
  do { const found = await fn(); if (found !== undefined) return found; await new Promise(r => setTimeout(r, 300)); } while (Date.now() < end);
}
export class CommunityAdapter {
  constructor(readonly platform: Platform, readonly config: AdapterConfig) {}
  get publishUrl() {
    return this.platform === 'ctrip' ? 'https://we.ctrip.com/publish/publishPictureText'
      : `${this.config.tripOrigin}/travel-guide/travelphoto-publish?locale=${encodeURIComponent(this.config.locale)}`;
  }
  get myNotesUrl() {
    return this.platform === 'ctrip' ? 'https://we.ctrip.com/publish/contentManagement'
      : `${this.config.tripOrigin}/travel-guide/personal-home?locale=${encodeURIComponent(this.config.locale)}`;
  }
  async goto(page: Page, raw: string) {
    const url = allowedUrl(raw, this.platform);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    if (!/\/(?:account\/)?login|passport|accounts\./i.test(page.url())) allowedUrl(page.url(), this.platform);
    await this.guard(page);
  }
  async guard(page: Page) {
    if (await page.getByText(/請完成驗證|请完成验证|拖动滑块|拖動滑塊|Verify you are human|安全验证/).filter({ visible: true }).count()) {
      fail('VERIFICATION_REQUIRED', '网站要求人工验证，请在本地浏览器完成后再继续。');
    }
  }
  async loginStatus(page: Page): Promise<{ logged_in: boolean | null; account_name?: string; message?: string }> {
    if (/\/(?:account\/)?login|passport|accounts\./i.test(page.url())) return { logged_in: false };
    await this.guard(page);
    if (this.platform === 'trip') {
      // Hydration initially renders a logged-out header. Wait for the final header signal.
      const state = await poll(async () => {
        const coins = page.locator('#headerCoins');
        if (await coins.isVisible().catch(() => false)) {
          const account = page.locator('button').filter({ has: page.locator('img[alt]') });
          const name = await account.count() ? await account.first().getAttribute('aria-label') : null;
          return { logged_in: true, ...(name ? { account_name: name } : {}) };
        }
      }, 5000);
      if (state) return state;
      if (await page.getByRole('button', { name: /登入.*註冊|登录.*注册|Sign in|Log in/i }).isVisible().catch(() => false)) return { logged_in: false };
    } else {
      if (await page.getByText(/退出登录|退出登錄|创作中心|创作服务平台/).filter({ visible: true }).count()) return { logged_in: true };
      if (await page.locator('input[type=file]').count() && page.url().includes('/publish/')) return { logged_in: true };
    }
    return { logged_in: null, message: '未识别到可靠登录标识，请在可见浏览器核对。' };
  }
  async requireLogin(page: Page) {
    const state = await this.loginStatus(page);
    if (state.logged_in !== true) fail('LOGIN_REQUIRED', '请先调用 open_login，在本地浏览器登录，再调用 check_login。');
  }
  async titleInput(page: Page) {
    return uniqueVisible([
      page.getByPlaceholder(/新增標題|新增标题|Add.*title|Enter.*title/i),
      page.getByPlaceholder(/标题|標題/), page.locator('input[role=textbox], textarea[role=textbox]'),
    ], '标题输入框');
  }
  async bodyInput(page: Page) {
    return uniqueVisible([page.locator('#textarea[contenteditable=true]'), page.locator('[contenteditable=true][role=combobox]'), page.locator('[contenteditable=true]'), page.getByPlaceholder(/分享.*经历|分享.*經歷|Share your/)], '正文输入框');
  }
  async locationInput(page: Page) {
    return uniqueVisible([page.locator('#location input'), page.getByPlaceholder(/選取.*地點|选择.*地点|Select.*location|Select.*destination/i), page.locator('.ant-select-selection-search-input')], '地点输入框');
  }
  async locations(page: Page, query: string) {
    const input = await this.locationInput(page); await input.fill(query);
    const selector = this.platform === 'trip' ? '#scrollDom li' : '.ant-select-item-option';
    await page.locator(selector).first().waitFor({ state: 'visible' });
    return page.locator(selector).evaluateAll(items => items.map(item => ({
      label: (item.textContent ?? '').replace(/\s+/g, ' ').trim(),
      name: (item.querySelector('.right > span:first-child, .ant-select-item-option-content')?.textContent ?? item.textContent ?? '').trim(),
    })).slice(0, 30));
  }
  async prepare(page: Page, post: Post) {
    await this.goto(page, this.publishUrl); await this.requireLogin(page);
    await (await this.titleInput(page)).fill(post.title);
    await (await this.bodyInput(page)).fill(renderedContent(post));
    const options = await this.locations(page, post.destination);
    const wanted = post.destination_option;
    const candidates = options.filter(o => wanted ? o.label === wanted : o.name === post.destination);
    if (candidates.length !== 1) fail('DESTINATION_AMBIGUOUS', `请通过 search_destinations 选择唯一地点，并传入 destination_option。候选：${JSON.stringify(options)}`);
    const selector = this.platform === 'trip' ? '#scrollDom li' : '.ant-select-item-option';
    const index = options.indexOf(candidates[0]!);
    await page.locator(selector).nth(index).click();
    await page.locator(selector).first().waitFor({ state: 'hidden' });
    const input = page.locator('input[type=file]:not(:disabled)');
    const uploads = await input.all();
    const images: Locator[] = [];
    for (const candidate of uploads) { if (/image/i.test(await candidate.getAttribute('accept') ?? '')) images.push(candidate); }
    const upload = images.length === 1 ? images[0]! : uploads.length === 1 ? uploads[0]! : undefined;
    if (!upload) fail('PAGE_CHANGED', '无法唯一定位图片上传控件。');
    await upload.setInputFiles(post.images);
    const completed = await poll(async () => {
      const error = page.locator('.ant-message-error, .ant-upload-list-item-error, [role=alert]').filter({ hasText: /失败|失敗|failed|error/i });
      if (await error.count()) fail('UPLOAD_FAILED', '网站报告图片上传失败。');
      if (this.platform === 'trip') {
        const count = await page.locator('.current-total').innerText().catch(() => '');
        if (Number(count.match(/^(\d+)\s*\//)?.[1]) === post.images.length) return true;
      } else {
        if (await page.locator('.ant-upload-list-item-done, .el-upload-list__item.is-success').count() === post.images.length) return true;
      }
    }, 60000);
    if (!completed) fail('UPLOAD_UNVERIFIED', '未能核实全部图片上传完成；保留编辑页，请勿直接提交。');
    await this.assertContent(page, post);
    return this.formSignature(page);
  }
  async assertContent(page: Page, post: Post) {
    const title = await (await this.titleInput(page)).inputValue();
    const body = await (await this.bodyInput(page)).innerText();
    if (title !== post.title || body.replace(/\r\n/g, '\n').trim() !== renderedContent(post).trim()) fail('FORM_MISMATCH', '网站中的标题或正文与准备内容不一致。');
  }
  async formSignature(page: Page) {
    const data = await page.evaluate(() => ({
      fields: Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]), textarea, [contenteditable=true]')).map(el => ({
        name: el.getAttribute('placeholder') ?? el.getAttribute('name'),
        value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement).innerText,
        files: el instanceof HTMLInputElement && el.files ? Array.from(el.files).map(f => [f.name, f.size, f.lastModified]) : [],
      })),
      location: document.querySelector('#location')?.textContent,
      count: document.querySelector('.current-total')?.textContent,
      selections: Array.from(document.querySelectorAll('.ant-select-selection-item')).map(e => e.textContent),
    }));
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
  async submit(page: Page, acceptTerms: boolean) {
    await this.guard(page); await this.requireLogin(page);
    if (this.platform === 'trip') {
      const consent = page.locator('img.checkbox-icon[alt*=unselected]');
      if (await consent.count()) {
        if (!acceptTerms) fail('TERMS_REQUIRED', '发布页要求确认素材所有权并接受平台条款，请用户阅读并明确同意。');
        await consent.click();
        await consent.waitFor({ state: 'hidden' });
      }
      await (await uniqueVisible([page.locator('.submit'), page.getByRole('button', { name: /^(提交|Submit|Post)$/i })], '提交按钮')).click();
    } else {
      // Only click the verified submit control. Unknown consent dialogs require user handling.
      await (await uniqueVisible([page.getByRole('button', { name: /^发\s*布$/ }), page.getByRole('button', { name: /^發\s*佈$/ })], '发布按钮')).click();
    }
  }
  async evidence(page: Page): Promise<Evidence> {
    const result = await poll(async (): Promise<Evidence | undefined> => {
      const id = noteId(page.url(), this.platform);
      if (id) return { status: 'submitted', url: page.url(), note_id: id, message: '已跳转到带文章 ID 的页面；尚未核验公开可见性。' };
      // Do not scan the article/editor body: user text can itself contain "提交成功".
      const markers = page.locator('[role=alert], .ant-message, .success, .result');
      const texts = await markers.allTextContents();
      if (texts.some(t => /审核中|審核中|等待审核|待審核|under review|pending review/i.test(t))) return { status: 'pending_review', message: '页面显示审核中。' };
      if (texts.some(t => /发布成功|發佈成功|提交成功|successfully (?:posted|published|submitted)/i.test(t))) return { status: 'submitted', message: '页面显示提交成功；尚未核验公开可见性。' };
    }, 12000);
    return result ?? { status: 'unknown', message: '提交结果未确认。禁止直接重试；请核对个人笔记列表。' };
  }
  async list(page: Page, url: string, keyword = '', limit = 20, scrolls = 2): Promise<{ notes: Note[]; scanned: number; scope: string }> {
    await this.goto(page, url);
    if (url === this.myNotesUrl) await this.requireLogin(page);
    await poll(async () => (await page.locator('article, [role=article], a[href*="/moments/detail/"], a[href*="/travelguide/"]').count()) ? true : undefined, 5000);
    const notes = new Map<string, Note>();
    for (let turn = 0; turn <= scrolls; turn++) {
      const raw = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('a[href*="/moments/detail/"], a[href*="/travelguide/"], a[href*="/travels/"], a[href*="articleId="], article, [role=article]'));
        return rows.filter(e => e.getBoundingClientRect().width > 0).map(e => {
          const a = e instanceof HTMLAnchorElement ? e : e.querySelector('a[href]') ?? e.closest('a[href]');
          return { title: (e as HTMLElement).innerText?.trim().slice(0, 300) ?? '', url: a?.getAttribute('href') ? new URL(a.getAttribute('href')!, location.href).href : undefined };
        });
      });
      for (const row of raw) {
        const id = row.url ? noteId(row.url, this.platform) : undefined;
        if (row.url && !id) continue;
        if (row.title) notes.set(row.url ?? row.title, { ...row, note_id: id });
      }
      if (turn < scrolls) { await page.mouse.wheel(0, 800); await page.waitForTimeout(700); }
    }
    if (!notes.size) {
      const empty = await page.getByText(/暂无.*(?:内容|笔记|作品)|暫無.*(?:內容|貼文)|No (?:posts|moments)|尚未發佈/i).count();
      if (!empty) fail('LIST_UNVERIFIED', '没有识别到笔记卡片或明确空列表；可能需要登录、加载或更新适配器。');
    }
    return { notes: [...notes.values()].filter(n => n.title.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())).slice(0, limit), scanned: notes.size, scope: '仅当前页面及指定滚动范围内已加载笔记；keyword 是本地标题过滤，不是全站搜索。' };
  }
  async detail(page: Page, url: string) {
    if (!noteId(url, this.platform)) fail('INVALID_NOTE_URL', '请提供 Trip Moments 或携程笔记/游记详情链接。');
    await this.goto(page, url);
    const data = await page.evaluate(() => {
      const article = document.querySelector('article, [role=main], main, .ctd_content, .gs-detail-content');
      return {
        title: document.querySelector('h1')?.textContent?.trim() ?? document.title,
        text: (article as HTMLElement | null)?.innerText?.trim() ?? '',
        description: document.querySelector('meta[name=description]')?.getAttribute('content') ?? '',
        images: Array.from((article ?? document).querySelectorAll('img')).map(i => i.currentSrc || i.src).filter(u => /^https:\/\//.test(u)).slice(0, 30),
      };
    });
    if (!data.text && !data.description) fail('CONTENT_UNVERIFIED', '页面未提供可识别正文，可能存在登录或加载限制。');
    return { ...data, text: data.text.slice(0, 20000), url: page.url(), note_id: noteId(page.url(), this.platform), extraction: data.text ? 'dom_article' : 'metadata_only', untrusted_content: true };
  }
}
