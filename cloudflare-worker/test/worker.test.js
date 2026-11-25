import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { normalizeUrl, refreshJob } from '../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const TOKEN = 'private-test-workspace-token-123456';
const UUID = '11111111-1111-4111-8111-111111111111';

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_content.sql', import.meta.url), 'utf8'));
  const wrap = (sql, params = []) => ({
    sql, params,
    bind(...values) { return wrap(sql, values); },
    async run() { const result = sqlite.prepare(sql).run(...params); return { meta: { changes: result.changes } }; },
    async first() { return sqlite.prepare(sql).get(...params) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
  });
  const DB = {
    prepare: wrap,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { for (const statement of statements) await statement.run(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { DB, APP_TOKEN: TOKEN, WATERCRAWL_API_KEY: 'upstream-secret', WATERCRAWL_BASE_URL: 'https://provider.example', ASSETS: { fetch: () => new Response('UI') } };
}
function request(path, body, auth = TOKEN) {
  return new Request(`https://app.example${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function seed(env, id = UUID, url = 'https://example.com/', age = 0) {
  const now = Date.now() - age;
  await env.DB.prepare('INSERT INTO jobs (id,url,provider_id,created_at,updated_at) VALUES (?,?,?,?,?)')
    .bind(id, url, UUID, now, now).run();
  return env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
}
function complete(markdown = '# Hello', metadata = { title: 'A page' }) {
  globalThis.fetch = async url => Response.json(String(url).includes('/results/')
    ? { results: [{ result: { markdown, metadata } }] }
    : { status: 'finished' });
}

test('normalizes a public URL and rejects unsafe schemes, hosts and credentials', () => {
  assert.equal(normalizeUrl(' https://Example.com/blog#part '), 'https://example.com/blog');
  for (const url of ['file:///etc/passwd', 'https://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'https://a.local', 'https://u:p@example.com', 'https://example.com:9000', 'bad']) {
    assert.throws(() => normalizeUrl(url));
  }
});
test('serves UI publicly and requires authentication for every API', async () => {
  const env = environment();
  assert.equal((await worker.fetch(request('/'), env)).status, 200);
  for (const path of ['/api/pages', '/api/jobs', `/api/pages/${UUID}`, `/api/jobs/${UUID}`]) {
    assert.equal((await worker.fetch(request(path, null, 'wrong'), env)).status, 401);
  }
});
test('fails closed without a configured strong application token', async () => {
  const env = environment(); env.APP_TOKEN = '';
  assert.equal((await worker.fetch(request('/api/pages'), env)).status, 503);
});
test('rejects a cross-origin mutation', async () => {
  const req = request('/api/jobs', { url: 'https://example.com' });
  req.headers.set('Origin', 'https://attacker.example');
  assert.equal((await worker.fetch(req, environment())).status, 403);
});
test('creates a single-page crawl with the actual upstream API-key header', async () => {
  const env = environment();
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://provider.example/api/v1/core/crawl-requests/');
    assert.equal(options.headers['X-API-Key'], 'upstream-secret');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.options.spider_options, { max_depth: 0, page_limit: 1 });
    return Response.json({ uuid: UUID });
  };
  const response = await worker.fetch(request('/api/jobs', { url: 'https://example.com' }), env);
  assert.equal(response.status, 202);
  const job = await env.DB.prepare('SELECT * FROM jobs').first();
  assert.equal(job.provider_id, UUID);
  assert.equal(job.status, 'pending');
  assert.equal((await worker.fetch(request('/api/jobs', { url: 'https://example.com' }), env)).status, 409);
});
test('rejects invalid request JSON and URLs without contacting the provider', async () => {
  const env = environment();
  globalThis.fetch = () => assert.fail('must not fetch');
  assert.equal((await worker.fetch(request('/api/jobs', { url: 'http://127.0.0.1/' }), env)).status, 400);
  const req = new Request('https://app.example/api/jobs', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal((await worker.fetch(req, env)).status, 400);
});
test('limits concurrent admission to five jobs', async () => {
  const env = environment();
  for (let i = 0; i < 5; i++) await seed(env, `${i}`.padEnd(36, '0'), `https://example.com/${i}`);
  assert.equal((await worker.fetch(request('/api/jobs', { url: 'https://example.com/new' }), env)).status, 409);
});
test('records upstream creation failure without exposing its response or secrets', async () => {
  const env = environment();
  globalThis.fetch = async () => new Response('SECRET upstream body', { status: 403 });
  const response = await worker.fetch(request('/api/jobs', { url: 'https://example.com' }), env);
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /SECRET|upstream-secret/);
  assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'failed');
});
test('persists markdown and metadata and upserts an existing URL without duplication', async () => {
  const env = environment();
  complete();
  await refreshJob(env, await seed(env));
  const first = await env.DB.prepare('SELECT * FROM pages').first();
  assert.equal(first.markdown, '# Hello');
  assert.equal(JSON.parse(first.metadata).title, 'A page');
  assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'saved');
  complete('# Updated');
  await refreshJob(env, await seed(env, '22222222-2222-4222-8222-222222222222'));
  const pages = await env.DB.prepare('SELECT * FROM pages').all();
  assert.equal(pages.results.length, 1);
  assert.equal(pages.results[0].id, first.id);
  assert.equal(pages.results[0].markdown, '# Updated');
});
test('an older job completing later does not overwrite newer content', async () => {
  const env = environment();
  const old = await seed(env, '22222222-2222-4222-8222-222222222222', 'https://example.com/', 10000);
  complete('# New'); await refreshJob(env, await seed(env));
  complete('# Old'); await refreshJob(env, old);
  assert.equal((await env.DB.prepare('SELECT * FROM pages').first()).markdown, '# New');
});
test('provider transient errors remain pending for a later cron retry', async () => {
  const env = environment(); const job = await seed(env);
  globalThis.fetch = async () => { throw new Error('network down'); };
  await refreshJob(env, job);
  assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'pending');
  await env.DB.prepare('UPDATE jobs SET checked_at=0').run();
  complete();
  await worker.scheduled({}, env);
  assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'saved');
});
test('failed D1 transaction rolls back page and job status, allowing retry', async () => {
  const env = environment(); const job = await seed(env);
  complete();
  const batch = env.DB.batch;
  env.DB.batch = statements => batch([...statements, env.DB.prepare('INSERT INTO missing_table VALUES (1)')]);
  await refreshJob(env, job);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM pages').first()).n, 0);
  assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'pending');
  env.DB.batch = batch;
  await env.DB.prepare('UPDATE jobs SET checked_at=0').run();
  await refreshJob(env, job);
  assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'saved');
});
test('rejects oversized content and empty extraction without creating a page', async () => {
  for (const markdown of ['', 'é'.repeat(760000)]) {
    const env = environment(); complete(markdown);
    await refreshJob(env, await seed(env));
    assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'failed');
    assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM pages').first()).n, 0);
  }
});
test('stops failed provider jobs and expires abandoned jobs', async () => {
  for (const age of [0, 21 * 60 * 1000]) {
    const env = environment();
    globalThis.fetch = async () => Response.json({ status: 'failed' });
    await refreshJob(env, await seed(env, UUID, 'https://example.com/', age));
    assert.equal((await env.DB.prepare('SELECT * FROM jobs').first()).status, 'failed');
  }
});
test('authenticated page listing and preview return persisted data', async () => {
  const env = environment(); complete(); await refreshJob(env, await seed(env));
  const list = await (await worker.fetch(request('/api/pages'), env)).json();
  assert.equal(list.stats.pages, 1);
  assert.equal(list.pages[0].markdown, undefined);
  const detail = await (await worker.fetch(request(`/api/pages/${list.pages[0].id}`), env)).json();
  assert.equal(detail.markdown, '# Hello');
});
