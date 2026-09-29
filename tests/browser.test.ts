import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { BrowserPool } from '../src/browser.js';
import { TripService } from '../src/service.js';
import { CommunityAdapter } from '../src/adapters.js';
import { postSchema } from '../src/domain.js';

// Deliberately minimal local fixtures. No real accounts or platform network requests.
function fixture(platform: 'trip' | 'ctrip') {
  const trip = platform === 'trip';
  return `<!doctype html><html><body>
    ${trip ? '<a id="headerCoins">Coins</a>' : '<div>创作中心</div>'}
    <input placeholder="新增標題，更大機會成為高質貼文！">
    <div id="textarea" contenteditable="true"></div>
    <div id="location"><input placeholder="請選取一個地點"><ul id="scrollDom" style="display:none"><li><p class="right"><span>上海</span><span class="subtitle">中國</span></p></li><li><p class="right"><span>上海酒店</span><span>中國</span></p></li></ul></div>
    ${trip ? '' : '<input class="ant-select-selection-search-input"><div class="ant-select-item-option" style="display:none"><span class="ant-select-item-option-content">上海</span></div>'}
    <input type="file" accept="image/png" multiple><p class="current-total">0 / 20</p><div id="uploads"></div>
    <img class="checkbox-icon" alt="tripshoot-checkbox_unselected" width="20" height="20" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5H0AAAAASUVORK5CYII=">
    ${trip ? '<div class="submit">提交</div>' : '<button>发 布</button>'}<div role="alert" id="result"></div>
    <script>
      window.submits=0;
      document.querySelector('#location input').addEventListener('input',()=>{
        document.querySelector('#scrollDom').style.display='block';
        const opt=document.querySelector('.ant-select-item-option');if(opt)opt.style.display='block';
      });
      for(const li of document.querySelectorAll('li,.ant-select-item-option'))li.onclick=()=>{
        document.querySelector('#location input').value=li.querySelector('span').textContent;
        document.querySelector('#scrollDom').style.display='none';
        const opt=document.querySelector('.ant-select-item-option');if(opt)opt.style.display='none';
      };
      document.querySelector('input[type=file]').onchange=e=>{
        document.querySelector('.current-total').textContent=e.target.files.length+' / 20';
        document.querySelector('#uploads').innerHTML=Array.from(e.target.files).map(()=>'<div class="ant-upload-list-item-done"></div>').join('');
      };
      document.querySelector('.checkbox-icon').onclick=e=>e.target.alt='tripshoot-checkbox_selected';
      document.querySelector('.submit,button').onclick=()=>{window.submits++;document.querySelector('#result').textContent='提交成功';};
    </script></body></html>`;
}

for (const platform of ['trip', 'ctrip'] as const) {
  test(`${platform}: 图文准备、预览变更拦截、协议提交与持久防重`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-browser-'));
    const store = new Store(dir); await store.init();
    const pool = new BrowserPool(store, true);
    const service = new TripService(store, pool, { tripOrigin: 'https://hk.trip.com', locale: 'zh-HK' });
    const session = { platform, account: 'fixture' };
    try {
      const ctx = await pool.context(session);
      await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(platform) }));
      const file = path.join(dir, 'sample.png');
      await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5H0AAAAASUVORK5CYII=', 'base64'));
      const post = postSchema.parse({ ...session, title: '上海漫步', content: '真实测试正文，仅本地模拟站点。', images: [file], destination: '上海' });
      const [job, duplicate] = await Promise.all([service.prepare(post), service.prepare(post)]);
      assert.equal(job.status, 'prepared'); assert.equal(job.id, duplicate.id);
      const page = ctx.pages().find(p => p.url().includes('/publish/') || p.url().includes('travelphoto-publish'))!;
      await page.locator('#textarea').fill('changed');
      await assert.rejects(service.publish(job.id, true, true), /不一致/);
      assert.equal((await store.get(job.id)).status, 'prepared');
      await page.locator('#textarea').fill(post.content);
      if (platform === 'trip') await assert.rejects(service.publish(job.id, true, false), /条款/);
      await assert.rejects(service.publish(job.id, false, true), /确认/);
      const [published, again] = await Promise.all([service.publish(job.id, true, true), service.publish(job.id, true, true)]);
      assert.equal(published.status, 'submitted'); assert.equal(again.status, 'submitted');
      assert.equal(await page.evaluate(() => (window as unknown as { submits: number }).submits), 1);
      // A click can succeed while observing its result fails. Never click again in that case.
      const uncertainPost = { ...post, title: '结果未知测试' };
      const uncertain = await service.prepare(uncertainPost);
      const uncertainPage = ctx.pages().find(p => p !== page && p.url().includes(platform === 'trip' ? 'travelphoto-publish' : '/publish/'))!;
      const adapterPrototype = CommunityAdapter.prototype;
      const originalEvidence = adapterPrototype.evidence;
      try {
        adapterPrototype.evidence = async () => { throw new Error('Simulated connection loss after click'); };
        assert.equal((await service.publish(uncertain.id, true, true)).status, 'unknown');
        assert.equal((await service.publish(uncertain.id, true, true)).status, 'unknown');
        assert.equal(await uncertainPage.evaluate(() => (window as unknown as { submits: number }).submits), 1);
        await assert.rejects(service.cancel(uncertain.id), /不能取消/);
      } finally { adapterPrototype.evidence = originalEvidence; }
      // A process that stopped after persisting submitting is also not safe to retry.
      const restarted = new TripService(store, pool, service.config);
      await store.update(uncertain.id, { status: 'submitting' });
      assert.equal((await restarted.status(uncertain.id)).status, 'unknown');
      assert.equal((await restarted.publish(uncertain.id, true, true)).status, 'unknown');
      assert.equal(await uncertainPage.evaluate(() => (window as unknown as { submits: number }).submits), 1);
      await assert.rejects(service.cancel(job.id), /不能取消/);
      assert.equal((await service.prepare(post)).id, job.id);
      // A restarted service must preserve the submitted record without clicking again.
      assert.equal((await restarted.publish(job.id, true, true)).status, 'submitted');
      assert.equal(await page.evaluate(() => (window as unknown as { submits: number }).submits), 1);
    } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('查询范围明确，保留无链接卡片，详情不把摘要称为完整正文', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-list-')); const store = new Store(dir); await store.init();
  const pool = new BrowserPool(store, true); const page = await pool.page({ platform: 'trip', account: 'reader' });
  const adapter = new CommunityAdapter('trip', { tripOrigin: 'https://hk.trip.com', locale: 'zh-HK' });
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<a href="/moments/detail/shanghai-2-12345/">上海散步</a><div role="article">杭州笔记</div><a href="/hotels/">酒店预订</a>' }));
    const result = await adapter.list(page, 'https://hk.trip.com/moments/shanghai-2/', '上海', 20, 0);
    assert.equal(result.scanned, 2); assert.equal(result.notes.length, 1); assert.equal(result.notes[0]?.note_id, '12345');
    await page.unroute('**/*');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>测试文章</title><meta name="description" content="仅摘要">' }));
    const detail = await adapter.detail(page, 'https://hk.trip.com/moments/detail/shanghai-2-12345/');
    assert.equal(detail.extraction, 'metadata_only'); assert.equal(detail.text, '');
  } finally { await pool.close(); await rm(dir, { recursive: true, force: true }); }
});
