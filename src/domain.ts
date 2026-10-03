import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const platformSchema = z.enum(['ctrip', 'trip']);
export type Platform = z.infer<typeof platformSchema>;
export const accountSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/).default('default');
export const sessionShape = { platform: platformSchema, account: accountSchema };
export type Session = { platform: Platform; account: string };
export const postSchema = z.object({
  ...sessionShape,
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20000),
  images: z.array(z.string()).min(1).max(20),
  destination: z.string().trim().min(1).max(200),
  destination_option: z.string().trim().min(1).max(300).optional(),
  content_declaration: z.enum(['内容无需声明', '内容为自行拍摄', '含AI合成内容', '含虚构演绎内容', '内容含营销信息', '内容为转载', '个人观点，仅供参考']).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
export type Post = z.infer<typeof postSchema>;
export type Status = 'preparing' | 'prepared' | 'submitting' | 'submitted' | 'pending_review' | 'published' | 'unknown' | 'failed';
export interface Evidence { status: Status; url?: string; note_id?: string; message?: string }
export interface Job extends Evidence {
  id: string; fingerprint: string; platform: Platform; account: string;
  title: string; created_at: string; updated_at: string; screenshot?: string;
}
export class TripError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function fail(code: string, message: string): never { throw new TripError(code, message); }

export function tripOrigin(value = 'https://hk.trip.com'): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !/^(?:www|hk|tw|us|uk|sg|my|au|jp|kr|de|fr|es|it|th|id|vn)\.trip\.com$/.test(u.hostname)
      || u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    fail('INVALID_ORIGIN', 'TRIP_MCP_TRIP_ORIGIN 必须是支持的 Trip.com HTTPS 站点根地址。');
  }
  return u.origin;
}
export function allowedUrl(raw: string, platform: Platform): URL {
  const u = new URL(raw);
  const hosts = platform === 'trip' ? /^(?:[a-z]{2,3}\.)?trip\.com$/ : /^(?:you|we|www|m)\.ctrip\.com$/;
  if (u.protocol !== 'https:' || !hosts.test(u.hostname) || u.port || u.username || u.password) {
    fail('INVALID_URL', '仅允许所选平台的 HTTPS 页面，禁止自定义端口或 URL 凭据。');
  }
  const paths = platform === 'trip' ? /^\/(moments(?:\/|$)|travel-guide(?:\/|$))/ : /^\/(travels(?:\/|$)|travelguide(?:\/|$)|moments(?:\/|$)|members(?:\/|$)|publish(?:\/|$)|searchsite(?:\/|$))/;
  if (!paths.test(u.pathname)) fail('INVALID_URL', '仅允许社区内容、个人主页及内容管理路径。');
  return u;
}
export function noteId(raw: string, platform: Platform): string | undefined {
  let u: URL;
  try { u = allowedUrl(raw, platform); } catch { return undefined; }
  if (platform === 'trip') return u.pathname.match(/\/moments\/detail\/[^/]*-(\d+)\/?$/)?.[1];
  return u.pathname.match(/\/travelguide\/[^/]+\/(\d+)\.html/)?.[1]
    ?? u.pathname.match(/\/travels\/\d+\/(\d+)\.html/)?.[1]
    ?? u.searchParams.get('articleId') ?? undefined;
}
export function renderedContent(post: Post): string {
  return post.content + (post.tags.length ? '\n\n' + post.tags.map(t => '#' + t.replace(/^#+/, '')).join(' ') : '');
}
export async function validatePost(post: Post): Promise<{ post: Post; fingerprint: string }> {
  if (post.platform === 'ctrip' && Array.from(post.title).length > 30) fail('TITLE_TOO_LONG', '国内站首版标题上限按当前页面建议设为 30 字。');
  if (post.platform === 'ctrip' && Array.from(renderedContent(post)).length > 3000) fail('CONTENT_TOO_LONG', '国内站正文和话题合计不得超过 3000 字。');
  const hashes: string[] = [];
  const images: string[] = [];
  for (const input of post.images) {
    if (!path.isAbsolute(input)) fail('INVALID_IMAGE', '图片须使用本地绝对路径。');
    const file = await realpath(input);
    const info = await stat(file);
    if (!info.isFile() || info.size > 10 * 1024 * 1024 || info.size === 0) fail('INVALID_IMAGE', '图片必须是非空普通文件，单张不超过 10 MiB。');
    const bytes = await readFile(file);
    const signature = bytes.subarray(0, 8).toString('hex');
    const valid = signature.startsWith('ffd8ff') || signature === '89504e470d0a1a0a' || bytes.subarray(0, 6).toString().match(/^GIF8[79]a$/);
    if (!valid || !/\.(?:jpe?g|png|gif)$/i.test(file)) fail('INVALID_IMAGE', '仅支持文件头匹配的 JPG、PNG、GIF。');
    hashes.push(createHash('sha256').update(bytes).digest('hex')); images.push(file);
  }
  if (new Set(hashes).size !== hashes.length) fail('DUPLICATE_IMAGE', '同一篇笔记包含重复图片。');
  const normalized = { ...post, images };
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...normalized, images: hashes })).digest('hex');
  return { post: normalized, fingerprint };
}
