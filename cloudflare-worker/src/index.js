const encoder = new TextEncoder();
const JOB_TIMEOUT = 20 * 60 * 1000;
const MAX_CONTENT = 1_500_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export function normalizeUrl(value) {
  if (typeof value !== 'string' || value.length > 3000) throw new HttpError(400, 'URL không hợp lệ.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new HttpError(400, 'Nhập URL đầy đủ, bắt đầu bằng https://.'); }
  const host = url.hostname.toLowerCase();
  // Public DNS names only. The WaterCrawl server must also block private IPs after DNS resolution/redirects.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) || !host.includes('.') ||
      /[\[\]:]/.test(host) || /^[\d.]+$/.test(host) ||
      /\.(localhost|local|internal|lan|test|invalid|example)$/.test(host)) {
    throw new HttpError(400, 'Chỉ hỗ trợ URL website công khai, không chứa thông tin đăng nhập.');
  }
  url.hash = '';
  return url.href;
}

async function authorize(request, env) {
  if (!env.APP_TOKEN || env.APP_TOKEN.length < 24) throw new HttpError(503, 'Chưa cấu hình APP_TOKEN (tối thiểu 24 ký tự).');
  const provided = request.headers.get('Authorization') || '';
  const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  const [a, b] = await Promise.all([digest(provided), digest(`Bearer ${env.APP_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) throw new HttpError(401, 'Khóa truy cập không đúng.');
}

async function readJson(response, limit = 2_000_000, clientInput = false) {
  if (!response.body) throw new HttpError(clientInput ? 400 : 502, 'Không nhận được dữ liệu JSON.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new HttpError(413, clientInput ? 'Yêu cầu quá lớn.' : 'Nội dung quá lớn để lưu vào D1.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(clientInput ? 400 : 502, clientInput ? 'Yêu cầu JSON không hợp lệ.' : 'WaterCrawl trả về JSON không hợp lệ.'); }
}

async function watercrawl(env, path, body) {
  if (!env.WATERCRAWL_API_KEY) throw new HttpError(503, 'Chưa cấu hình WATERCRAWL_API_KEY.');
  const base = new URL(env.WATERCRAWL_BASE_URL);
  if (!['https:', 'http:'].includes(base.protocol)) throw new HttpError(503, 'WATERCRAWL_BASE_URL không hợp lệ.');
  let response;
  try {
    response = await fetch(new URL(`/api/v1/core/crawl-requests/${path}`, base), {
      method: body ? 'POST' : 'GET',
      headers: { 'X-API-Key': env.WATERCRAWL_API_KEY, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
  } catch { throw new HttpError(502, 'Không kết nối được WaterCrawl. Hãy thử lại sau.'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, `WaterCrawl trả lỗi HTTP ${response.status}. Kiểm tra API key, quota và máy chủ.`);
  }
  return readJson(response);
}

async function failJob(env, id, message) {
  await env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(message, Date.now(), id).run();
}

export async function refreshJob(env, job) {
  if (job.status !== 'pending') return;
  if (Date.now() - job.created_at > JOB_TIMEOUT) {
    await failJob(env, job.id, 'Tác vụ đã quá 20 phút. Kiểm tra WaterCrawl trước khi thử lại.');
    return;
  }
  if (!job.provider_id) return;
  // A short D1 lease prevents the browser and cron from polling the same job together.
  const claim = await env.DB.prepare("UPDATE jobs SET checked_at = ? WHERE id = ? AND status = 'pending' AND checked_at < ?")
    .bind(Date.now(), job.id, Date.now() - 4000).run();
  if (!claim.meta.changes) return;
  try {
    const crawl = await watercrawl(env, `${job.provider_id}/`);
    if (['failed', 'canceled', 'cancelled'].includes(crawl.status)) {
      await failJob(env, job.id, 'WaterCrawl không hoàn tất được trang này.');
      return;
    }
    if (crawl.status !== 'finished') return;
    const list = await watercrawl(env, `${job.provider_id}/results/?prefetched=true&page_size=1`);
    const result = list.results?.[0]?.result;
    if (!result || typeof result.markdown !== 'string' || !result.markdown.trim()) {
      await failJob(env, job.id, 'Trang không trả về nội dung Markdown.');
      return;
    }
    const title = typeof result.metadata?.title === 'string' ? result.metadata.title.slice(0, 500) : new URL(job.url).hostname;
    const metadata = JSON.stringify(result.metadata || {});
    if (encoder.encode(result.markdown + metadata + title).byteLength > MAX_CONTENT) {
      await failJob(env, job.id, 'Nội dung vượt giới hạn 1,5 MB của ứng dụng.');
      return;
    }
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO pages (id, url, title, markdown, metadata, source_job, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET title=excluded.title, markdown=excluded.markdown,
        metadata=excluded.metadata, source_job=excluded.source_job, updated_at=excluded.updated_at
        WHERE excluded.updated_at >= pages.updated_at`)
        .bind(crypto.randomUUID(), job.url, title, result.markdown, metadata, job.id, job.created_at),
      env.DB.prepare("UPDATE jobs SET status='saved', error=NULL, updated_at=? WHERE id=? AND status='pending'")
        .bind(now, job.id),
    ]);
  } catch (error) {
    if (error.status === 413) { await failJob(env, job.id, error.message); return; }
    // Transient provider/D1 failures remain pending so cron can retry without recrawling.
    await env.DB.prepare("UPDATE jobs SET error=? WHERE id=? AND status='pending'")
      .bind('Đang chờ kết nối lại hoặc thử lưu lại kết quả.', job.id).run();
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  await authorize(request, env);
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Origin không được phép.');
  }
  if (url.pathname === '/api/pages' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id,url,title,length(markdown) AS characters,updated_at FROM pages ORDER BY updated_at DESC LIMIT 50').all();
    const stats = await env.DB.prepare('SELECT count(*) AS pages,coalesce(sum(length(markdown)),0) AS characters FROM pages').first();
    return json({ pages: rows.results, stats });
  }
  const pageMatch = url.pathname.match(/^\/api\/pages\/([\da-f-]{36})$/);
  if (pageMatch && request.method === 'GET') {
    const page = await env.DB.prepare('SELECT * FROM pages WHERE id=?').bind(pageMatch[1]).first();
    if (!page) throw new HttpError(404, 'Không tìm thấy trang.');
    return json(page);
  }
  if (url.pathname === '/api/jobs' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 20').all();
    return json({ jobs: rows.results });
  }
  if (url.pathname === '/api/jobs' && request.method === 'POST') {
    if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, 'Yêu cầu JSON.');
    const body = await readJson(request, 8192, true);
    const target = normalizeUrl(body?.url);
    if (!env.WATERCRAWL_API_KEY) throw new HttpError(503, 'Chưa cấu hình WATERCRAWL_API_KEY.');
    const id = crypto.randomUUID();
    const now = Date.now();
    // Atomic admission control: at most five in-flight jobs for this private workspace.
    const inserted = await env.DB.prepare(`INSERT INTO jobs (id,url,created_at,updated_at)
      SELECT ?,?,?,? WHERE (SELECT count(*) FROM jobs WHERE status='pending') < 5
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE url=? AND status='pending')`)
      .bind(id, target, now, now, target).run();
    if (!inserted.meta.changes) throw new HttpError(409, 'URL đang xử lý hoặc đã đủ 5 tác vụ đồng thời.');
    try {
      const crawl = await watercrawl(env, '', {
        url: target,
        options: {
          spider_options: { max_depth: 0, page_limit: 1 },
          page_options: { only_main_content: true, include_html: false, wait_time: 1000 },
          plugin_options: {},
        },
      });
      if (typeof crawl.uuid !== 'string' || !/^[\da-f-]{36}$/.test(crawl.uuid)) throw new HttpError(502, 'WaterCrawl không trả về mã tác vụ hợp lệ.');
      await env.DB.prepare('UPDATE jobs SET provider_id=? WHERE id=?').bind(crawl.uuid, id).run();
      return json({ id, url: target, status: 'pending' }, 202);
    } catch (error) {
      await failJob(env, id, error instanceof HttpError ? error.message : 'Không thể khởi tạo tác vụ.');
      throw error;
    }
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([\da-f-]{36})$/);
  if (jobMatch && request.method === 'GET') {
    const job = await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobMatch[1]).first();
    if (!job) throw new HttpError(404, 'Không tìm thấy tác vụ.');
    await refreshJob(env, job);
    return json(await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(job.id).first());
  }
  throw new HttpError(404, 'Endpoint không tồn tại.');
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (error) {
      if (!(error instanceof HttpError)) console.error('Worker operation failed:', error.name);
      return json({ error: error instanceof HttpError ? error.message : 'Không thể xử lý dữ liệu. Kiểm tra cấu hình D1 và migration.' }, error.status || 500);
    }
  },
  async scheduled(_controller, env) {
    const jobs = await env.DB.prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY checked_at ASC LIMIT 5").all();
    await Promise.allSettled(jobs.results.map(job => refreshJob(env, job)));
  },
};
