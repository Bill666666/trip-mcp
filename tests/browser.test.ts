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
    ${trip ? '<a id="headerCoins">Coins</a><a href="/travel-guide/travelphoto-publish?locale=zh-HK&curr=HKD">發佈</a>' : '<div>创作中心</div>'}
    ${trip ? '<input placeholder="新增標題，更大機會成為高質貼文！"><div id="textarea" contenteditable="true"></div>' : '<div role="textbox" contenteditable="true"></div><div role="combobox" contenteditable="true"></div>'}
    ${trip ? '<div id="location"><input placeholder="請選取一個地點"><ul id="scrollDom" style="display:none"><li><p class="right"><span>上海</span><span class="subtitle">中國</span></p></li><li><p class="right"><span>上海酒店</span><span>中國</span></p></li></ul></div>' : '<div class="ant-select ant-select-multiple"><input readonly class="ant-select-selection-search-input"><span>请输入地理位置</span></div><div class="search-input-detail"><div class="item-c" style="display:none"><span class="title">上海</span></div></div><div class="ant-select"><input readonly class="ant-select-selection-search-input"><span>请选择内容类型声明</span></div>'}
    <input type="file" accept="image/png" multiple><p class="current-total">0 / 20</p><div id="uploads"></div>
    ${trip ? '' : '<div id="declarations" style="display:none">含AI合成内容</div>'}
    <img class="checkbox-icon" alt="tripshoot-checkbox_unselected" width="20" height="20" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5H0AAAAASUVORK5CYII=">
    ${trip ? '<div class="submit">提交</div>' : '<button>发 布</button>'}<div role="alert" id="result"></div>
    <script>
      window.submits=0;
      const locationInput=document.querySelector('#location input,.ant-select-multiple input');
      const multi=document.querySelector('.ant-select-multiple');if(multi)multi.onclick=()=>locationInput.readOnly=false;
      locationInput.addEventListener('input',()=>{
        const list=document.querySelector('#scrollDom');if(list)list.style.display='block';
        const opt=document.querySelector('.search-input-detail .item-c');if(opt)opt.style.display='block';
      });
      for(const li of document.querySelectorAll('li,.search-input-detail .item-c'))li.onclick=()=>{
        locationInput.value=li.querySelector('span').textContent;
        const list=document.querySelector('#scrollDom');if(list)list.style.display='none';
        const opt=document.querySelector('.search-input-detail .item-c');if(opt)opt.style.display='none';
      };
      document.querySelector('input[type=file]').onchange=e=>{
        document.querySelector('.current-total').textContent=e.target.files.length+' / 20';
        document.querySelector('#uploads').innerHTML=Array.from(e.target.files).map((_,i)=>${trip ? "'<div class=\"ant-upload-list-item-done\"></div>'" : "'<div class=\"r-d-upload-image-container-done\" aria-roledescription=\"sortable\"><img alt=\"avatar\" src=\"https://dimg04.tripcdn.com/images/test-'+i+'.png\"></div>'"}).join('');
      };
      const declaration=document.querySelector('#declarations');
      if(declaration){
        const select=document.querySelector('.ant-select:not(.ant-select-multiple)');
        select.onclick=()=>declaration.style.display='block';
        declaration.onclick=()=>{select.innerHTML='<span class="ant-select-selection-item">含AI合成内容</span>';declaration.style.display='none';};
      }
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
      const navigations: string[] = [];
      await ctx.route('**/*', route => {
        if (route.request().resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5H0AAAAASUVORK5CYII=', 'base64') });
        if (route.request().isNavigationRequest()) navigations.push(route.request().url());
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(platform) });
      });
      const file = path.join(dir, 'sample.png');
      await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5H0AAAAASUVORK5CYII=', 'base64'));
      const post = postSchema.parse({ ...session, title: '上海漫步', content: '真实测试正文。\n\n仅本地模拟站点。', images: [file], destination: '上海', ...(platform === 'ctrip' ? { content_declaration: '含AI合成内容' } : {}) });
      const [job, duplicate] = await Promise.all([service.prepare(post), service.prepare(post)]);
      assert.equal(job.status, 'prepared'); assert.equal(job.id, duplicate.id);
      const page = ctx.pages().find(p => p.url().includes('/publish/') || p.url().includes('travelphoto-publish'))!;
      if (platform === 'trip') {
        assert.equal(new URL(navigations[0]!).pathname, '/travel-guide/');
        assert.equal(new URL(navigations[1]!).searchParams.get('curr'), 'HKD');
      } else {
        assert.equal(await page.locator('img[alt=avatar]').count(), 1);
        assert.equal(await page.locator('.ant-select-selection-item').innerText(), '含AI合成内容');
      }
      const body = await service.adapter(platform).bodyInput(page);
      await body.fill('changed');
      await assert.rejects(service.publish(job.id, true, true), /不一致/);
      assert.equal((await store.get(job.id)).status, 'prepared');
      await body.fill(post.content.replace(/\n\n/g, '\n\n\n'));
      await service.adapter(platform).assertContent(page, post);
      // Formatting tolerance must not conceal missing words or paragraph breaks.
      await body.fill(post.content.replace(/\n\n/g, ''));
      await assert.rejects(service.adapter(platform).assertContent(page, post), /不一致/);
      await body.fill(post.content);
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
      await assert.rejects(service.prepare({ ...post, destination: '上' }), /唯一地点/);
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

test('站点拦截单独报告，国内登录识别等待编辑器异步加载', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-guard-')); const store = new Store(dir); await store.init();
  const pool = new BrowserPool(store, true); const page = await pool.page({ platform: 'ctrip', account: 'guard' });
  const adapter = new CommunityAdapter('ctrip', { tripOrigin: 'https://hk.trip.com', locale: 'zh-HK' });
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body>whaleguard block</body>' }));
    await assert.rejects(adapter.goto(page, adapter.publishUrl), (e: unknown) => (e as {code: string}).code === 'SITE_BLOCKED');
    await page.unroute('**/*');
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<body><input type=file><script>setTimeout(()=>{document.body.innerHTML="<input type=file><nav>游记管理</nav>"},500)</script></body>' }));
    await adapter.goto(page, adapter.publishUrl);
    assert.equal((await adapter.loginStatus(page)).logged_in, true);
  } finally { await pool.close(); await rm(dir, { recursive: true, force: true }); }
});

test('国内列表等待零计数占位更新，提取实际卡片并保留分页范围', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctrip-list-')); const store = new Store(dir); await store.init();
  const pool = new BrowserPool(store, true); const page = await pool.page({ platform: 'ctrip', account: 'list' });
  const adapter = new CommunityAdapter('ctrip', { tripOrigin: 'https://hk.trip.com', locale: 'zh-HK' });
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<body><nav>游记管理</nav><div id="count">全部作品(0)</div><div class="c-m-container"></div><script>
      setTimeout(()=>{
        document.querySelector('#count').textContent='全部作品(19)';
        document.querySelector('.c-m-container').innerHTML='<div class="c-m-c-container"><div class="title">上海周末</div><div class="publish-status"><span class="status">已发布</span><span class="date">2026-09-29</span></div><div>编辑 删除</div></div><div class="page">共 19 条作品 第 1 / 4页</div>';
      },700);</script></body>` }));
    const result = await adapter.list(page, adapter.myNotesUrl, '', 20, 0);
    assert.equal(result.scanned, 1); assert.equal(result.notes[0]?.title, '上海周末');
    assert.equal(result.notes[0]?.status, '已发布'); assert.equal(result.notes[0]?.url, undefined);
    assert.deepEqual(result.pagination, { total_notes: 19, page: 1, total_pages: 4 });
  } finally { await pool.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Trip 提交导航中断后读取成功跳转，绝不再次点击', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-redirect-'));
  const store = new Store(dir); await store.init();
  const pool = new BrowserPool(store, true);
  const service = new TripService(store, pool, { tripOrigin: 'https://hk.trip.com', locale: 'zh-HK' });
  const ctx = await pool.context({ platform: 'trip', account: 'redirect' });
  const original = CommunityAdapter.prototype.submit;
  try {
    await ctx.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture('trip') }));
    const file = path.join(dir, 'sample.png');
    await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5H0AAAAASUVORK5CYII=', 'base64'));
    const job = await service.prepare(postSchema.parse({ platform: 'trip', account: 'redirect', title: '导航测试', content: '测试正文', images: [file], destination: '上海' }));
    let attempts = 0;
    CommunityAdapter.prototype.submit = async page => {
      attempts++;
      await page.goto('https://hk.trip.com/travel-guide/?publishResultJson=' + encodeURIComponent(JSON.stringify({ publishSuccess: 1 })));
      throw new Error('Navigation interrupted click observation');
    };
    assert.equal((await service.publish(job.id, true, true)).status, 'submitted');
    assert.equal((await service.publish(job.id, true, true)).status, 'submitted');
    assert.equal(attempts, 1);
  } finally { CommunityAdapter.prototype.submit = original; await service.close(); await rm(dir, { recursive: true, force: true }); }
});
