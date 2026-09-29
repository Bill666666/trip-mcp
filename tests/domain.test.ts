import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { allowedUrl, noteId, postSchema, tripOrigin, validatePost } from '../src/domain.js';
import { Store } from '../src/store.js';

test('URL 限制拒绝任意域、账号凭据、端口及非社区路径', () => {
  for (const bad of ['http://hk.trip.com/moments/', 'https://trip.com.evil.test/moments/', 'https://user:pass@hk.trip.com/moments/', 'https://127.0.0.1/moments/', 'https://hk.trip.com:8443/moments/', 'https://hk.trip.com/customer/cards']) {
    assert.throws(() => allowedUrl(bad, 'trip'));
  }
  assert.throws(() => allowedUrl('https://hk.trip.com/moments/', 'ctrip'));
  assert.throws(() => tripOrigin('https://hk.trip.com/path'));
  assert.equal(allowedUrl('https://you.ctrip.com/travelguide/paipai/123.html', 'ctrip').hostname, 'you.ctrip.com');
  assert.equal(noteId('https://hk.trip.com/moments/detail/shanghai-2-12345/', 'trip'), '12345');
  assert.equal(noteId('https://hk.trip.com/moments/shanghai-2/', 'trip'), undefined);
});
test('内容指纹包含图片内容，拒绝重复图片与伪装文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-domain-'));
  try {
    const file = path.join(dir, 'a.png');
    await writeFile(file, Buffer.from('89504e470d0a1a0a', 'hex'));
    const post = postSchema.parse({ platform: 'trip', title: '测试', content: '测试正文', images: [file], destination: '上海' });
    const a = await validatePost(post); const b = await validatePost(post);
    assert.equal(a.fingerprint, b.fingerprint);
    await assert.rejects(validatePost({ ...post, images: [file, file] }), /重复图片/);
    await writeFile(file, Buffer.from('89504e470d0a1a0a0000', 'hex'));
    assert.notEqual((await validatePost(post)).fingerprint, a.fingerprint);
    await writeFile(file, 'not an image');
    await assert.rejects(validatePost(post), /文件头/);
    assert.throws(() => postSchema.parse({ ...post, account: '../other' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('账号文件锁跨 Store 实例互斥，任务路径不能越界', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trip-store-'));
  try {
    const a = new Store(dir); const b = new Store(dir); await a.init();
    const session = { platform: 'trip' as const, account: 'default' };
    const release = await a.lock(session);
    await assert.rejects(b.lock(session), /另一个 MCP/);
    await release(); await (await b.lock(session))();
    assert.throws(() => a.jobPath('../../etc/passwd'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
