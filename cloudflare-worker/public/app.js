const $ = selector => document.querySelector(selector);
const format = value => new Intl.NumberFormat('vi-VN').format(value);
let token = '';
let pages = [];
let activeJobs = [];
let preview = null;
let polling = false;
let loading = false;

function feedback(message, error = false) {
  $('#feedback').textContent = message;
  $('#feedback').classList.toggle('error', error);
}

function disconnect() {
  token = '';
  pages = [];
  activeJobs = [];
  preview = null;
  $('#preview-content').textContent = '';
  $('#preview-dialog').close();
  $('#connect').textContent = 'Kết nối ↗';
  $('#connection-label').textContent = 'Chưa kết nối';
  $('#connection-dot').classList.remove('active');
  $('#stat-pages').textContent = '—';
  $('#stat-characters').textContent = '—';
  $('#library-count').textContent = '0';
  $('#pages').replaceChildren(empty('Kết nối để xem nội dung đã lưu.'));
  $('#jobs').replaceChildren(empty('Chưa kết nối workspace.'));
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  let body;
  try { body = await response.json(); } catch { throw new Error('Máy chủ trả về phản hồi không hợp lệ.'); }
  if (!response.ok) {
    if (response.status === 401) disconnect();
    throw new Error(body.error || `Yêu cầu thất bại (${response.status}).`);
  }
  return body;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function empty(text) { return element('div', 'empty', text); }

function renderPages() {
  const query = $('#filter').value.trim().toLocaleLowerCase();
  const visible = pages.filter(page => `${page.title} ${page.url}`.toLocaleLowerCase().includes(query));
  $('#library-count').textContent = pages.length;
  const rows = visible.map(page => {
    const row = element('article', 'page-row');
    const icon = element('span', 'page-icon');
    icon.innerHTML = '<svg aria-hidden="true"><use href="#i-file"/></svg>';
    const info = element('div', 'page-info');
    info.append(element('strong', '', page.title), element('p', '', `${page.url} · ${format(page.characters)} ký tự`));
    const button = element('button', 'button outline', 'Xem ↗');
    button.addEventListener('click', () => showPage(page.id));
    row.append(icon, info, element('span', 'saved-label', '● Đã lưu D1'), button);
    return row;
  });
  $('#pages').replaceChildren(...(rows.length ? rows : [empty(query ? 'Không tìm thấy nội dung phù hợp.' : 'Chưa có nội dung. Thêm URL đầu tiên phía trên.')]));
}

function renderJobs(jobs) {
  const names = { pending: '◌ Đang xử lý', saved: '✓ Đã lưu', failed: '✕ Thất bại' };
  $('#jobs').replaceChildren(...(jobs.length ? jobs.map(job => {
    const row = element('div', 'job-row');
    const info = element('div');
    info.append(element('strong', '', job.url), element('small', '', job.error || new Date(job.created_at).toLocaleString('vi-VN')));
    row.append(info, element('span', `job-status ${job.status}`, names[job.status]));
    return row;
  }) : [element('p', 'muted', 'Chưa có tác vụ nào.')]));
}

async function loadLibrary() {
  const [library, activity] = await Promise.all([api('/pages'), api('/jobs')]);
  // A disconnect during either request must not repopulate the private workspace.
  if (!token) return;
  pages = library.pages;
  activeJobs = activity.jobs.filter(job => job.status === 'pending');
  $('#stat-pages').textContent = format(library.stats.pages);
  $('#stat-characters').textContent = format(library.stats.characters);
  renderPages();
  renderJobs(activity.jobs);
}

$('#connect').addEventListener('click', () => {
  if (token) { disconnect(); feedback('Đã ngắt kết nối workspace.'); return; }
  $('#auth-error').textContent = '';
  $('#auth-dialog').showModal();
});
$('#cancel-auth').addEventListener('click', () => $('#auth-dialog').close());
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  token = $('#token').value.trim();
  try {
    await loadLibrary();
    $('#auth-dialog').close();
    $('#token').value = '';
    $('#connect').textContent = 'Ngắt kết nối ↗';
    $('#connection-label').textContent = 'Workspace đã kết nối';
    $('#connection-dot').classList.add('active');
    feedback('Đã kết nối. Dán URL để trích xuất và lưu vào D1.');
  } catch (error) {
    disconnect();
    $('#auth-error').textContent = error.message;
  } finally { button.disabled = false; }
});

$('#url').addEventListener('input', () => { $('#counter').textContent = `${format($('#url').value.length)}/3.000`; });
$('#filter').addEventListener('input', renderPages);
$('#capture-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!token) { $('#connect').click(); return; }
  $('#submit').disabled = true;
  feedback('Đang gửi URL tới WaterCrawl…');
  try {
    await api('/jobs', { method: 'POST', body: JSON.stringify({ url: $('#url').value }) });
    feedback('Đã tạo tác vụ. WaterCrawl đang trích xuất nội dung…');
    await loadLibrary();
  } catch (error) { feedback(error.message, true); }
  finally { $('#submit').disabled = false; }
});

$('#refresh').addEventListener('click', async () => {
  if (!token) { $('#connect').click(); return; }
  if (loading) return;
  loading = true;
  $('#refresh').disabled = true;
  try { await loadLibrary(); feedback('Đã cập nhật thư viện.'); }
  catch (error) { feedback(error.message, true); }
  finally { loading = false; $('#refresh').disabled = false; }
});

setInterval(async () => {
  if (!token || !activeJobs.length || polling || document.hidden) return;
  polling = true;
  try {
    const states = await Promise.all(activeJobs.map(job => api(`/jobs/${job.id}`)));
    if (!token) return;
    if (states.some(job => job.status === 'saved')) feedback('Đã trích xuất và lưu nội dung vào D1.');
    else if (states.some(job => job.status === 'failed')) feedback('Có tác vụ thất bại. Xem chi tiết trong Hoạt động gần đây.', true);
    await loadLibrary();
  } catch (error) { feedback(error.message, true); }
  finally { polling = false; }
}, 5000);

async function showPage(id) {
  try {
    const page = await api(`/pages/${id}`);
    if (!token) return;
    preview = page;
    $('#preview-title').textContent = page.title;
    $('#preview-url').textContent = page.url;
    $('#preview-url').href = page.url;
    $('#preview-content').textContent = page.markdown;
    $('#preview-dialog').showModal();
  } catch (error) { feedback(error.message, true); }
}
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#copy').addEventListener('click', async () => {
  if (!preview) return;
  try {
    await navigator.clipboard.writeText(preview.markdown);
    $('#copy').textContent = 'Đã sao chép ✓';
    setTimeout(() => { $('#copy').textContent = 'Sao chép'; }, 2000);
  } catch { $('#copy').textContent = 'Hãy chọn nội dung và sao chép thủ công'; }
});
$('#download').addEventListener('click', () => {
  if (!preview) return;
  const url = URL.createObjectURL(new Blob([preview.markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = `watercrawl-${preview.id}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Each fade resumes from current opacity and cancels the previous RAF animation.
const video = $('#hero-video');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let animationFrame = 0;
let fadingOutRef = false;
let restartTimer = 0;
let paused = reducedMotion.matches;
function fadeTo(target) {
  cancelAnimationFrame(animationFrame);
  const from = Number(getComputedStyle(video).opacity);
  const start = performance.now();
  function frame(now) {
    const progress = Math.min((now - start) / 250, 1);
    video.style.opacity = from + (target - from) * progress;
    if (progress < 1) animationFrame = requestAnimationFrame(frame);
  }
  animationFrame = requestAnimationFrame(frame);
}
function playVideo() {
  if (!paused) video.play().catch(() => { paused = true; updateMotionButton(); });
}
function updateMotionButton() {
  $('#motion').textContent = paused ? 'Phát nền' : 'Tạm dừng nền';
  $('#motion').setAttribute('aria-pressed', String(paused));
}
video.addEventListener('playing', () => { fadingOutRef = false; fadeTo(1); });
video.addEventListener('timeupdate', () => {
  if (Number.isFinite(video.duration) && video.duration - video.currentTime <= .55 && !fadingOutRef) {
    fadingOutRef = true;
    fadeTo(0);
  }
});
video.addEventListener('ended', () => {
  cancelAnimationFrame(animationFrame);
  video.style.opacity = '0';
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    video.currentTime = 0;
    fadingOutRef = false;
    playVideo();
  }, 100);
});
$('#motion').addEventListener('click', () => {
  paused = !paused;
  if (paused) { video.pause(); clearTimeout(restartTimer); cancelAnimationFrame(animationFrame); }
  else { if (video.ended) video.currentTime = 0; playVideo(); }
  updateMotionButton();
});
reducedMotion.addEventListener('change', event => {
  paused = event.matches;
  if (paused) { video.pause(); clearTimeout(restartTimer); cancelAnimationFrame(animationFrame); }
  else playVideo();
  updateMotionButton();
});
video.addEventListener('error', () => { $('#motion').hidden = true; });
updateMotionButton();
playVideo();
