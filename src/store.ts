import { mkdir, readdir, readFile, rename, writeFile, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail, type Job, type Session } from './domain.js';

export class Store {
  constructor(readonly root: string) {}
  async init() { for (const part of ['', 'jobs', 'profiles', 'artifacts', 'locks']) await mkdir(path.join(this.root, part), { recursive: true, mode: 0o700 }); }
  async save(job: Job) {
    const target = this.jobPath(job.id); const tmp = target + '.' + randomUUID() + '.tmp';
    await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o600 }); await rename(tmp, target);
  }
  jobPath(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail('INVALID_JOB', '无效的任务 ID。');
    return path.join(this.root, 'jobs', id + '.json');
  }
  async get(id: string): Promise<Job> { return JSON.parse(await readFile(this.jobPath(id), 'utf8')); }
  async jobs(): Promise<Job[]> {
    const files = (await readdir(path.join(this.root, 'jobs'))).filter(f => f.endsWith('.json'));
    return Promise.all(files.map(f => readFile(path.join(this.root, 'jobs', f), 'utf8').then(s => JSON.parse(s))));
  }
  async duplicate(fingerprint: string) {
    return (await this.jobs()).find(j => j.fingerprint === fingerprint && j.status !== 'failed');
  }
  async update(id: string, fields: Partial<Job>): Promise<Job> {
    const job = { ...await this.get(id), ...fields, updated_at: new Date().toISOString() }; await this.save(job); return job;
  }
  async lock(session: Session): Promise<() => Promise<void>> {
    const file = path.join(this.root, 'locks', `${session.platform}-${session.account}.lock`);
    let fd;
    try { fd = await open(file, 'wx', 0o600); }
    catch { fail('SESSION_BUSY', '该账号已由另一个 MCP 进程使用；异常退出后请确认进程已停止，再移除对应 lock 文件。'); }
    await fd.writeFile(String(process.pid)); await fd.close();
    return async () => { await unlink(file).catch(() => {}); };
  }
}
