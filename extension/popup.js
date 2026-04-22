// ─── State ────────────────────────────────────────────────────────────────────
const LS_JOBS = 'cre_tracker_jobs';
const LS_KEY  = 'cre_anthropic_key';

let jobs    = JSON.parse(localStorage.getItem(LS_JOBS) || '[]');
let sortCol = 'date';
let sortDir = 'desc';
let delId   = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const esc = s  => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const uid = ()  => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const iso = ()  => new Date().toISOString().slice(0,10);
const fmt = d   => d ? new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';

function persist() { localStorage.setItem(LS_JOBS, JSON.stringify(jobs)); }
function apiKey()  { return localStorage.getItem(LS_KEY) || ''; }

// ─── Alerts ───────────────────────────────────────────────────────────────────
function showAlert(id, type, html, spinner) {
  const el = $(id);
  el.className = `alert alert-${type}`;
  el.innerHTML = (spinner ? '<span class="spinner"></span>' : '') + html;
  el.classList.remove('hidden');
}
function hideAlert(id) { $(id).classList.add('hidden'); }

// ─── Claude API ───────────────────────────────────────────────────────────────
const EXTRACT_PROMPT = `Extract job details from this job posting. Return ONLY a valid JSON object — no markdown, no explanation.

Fields:
- company      (string)
- title        (string)
- location     (string — city, state or "Remote")
- deadline     (string — ISO date YYYY-MM-DD, or "" if not listed)
- bucket_guess (string — one of exactly: "Capital Markets Advisory", "Investment Sales Brokerage", "Leasing Brokerage", "Development", or "")
- notes_prefill (string — 1-2 sentences: key requirements, comp if mentioned, team context)

Bucket logic:
• Capital Markets Advisory — debt/equity placement, structured finance, investment banking-adjacent
• Investment Sales Brokerage — buying/selling commercial properties, deal teams, disposition
• Leasing Brokerage — leasing office/retail/industrial, tenant or landlord rep
• Development — ground-up development, construction management, value-add, asset management`;

async function callClaude(content) {
  const key = apiKey();
  if (!key) throw new Error('No API key — click API Key in the header first.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content }]
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Claude API error ${res.status}`);
  }

  const data  = await res.json();
  const raw   = data.content?.[0]?.text || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse Claude response');
  return JSON.parse(match[0]);
}

function fillForm(d, url) {
  if (d.company)       $('fCo').value      = d.company;
  if (d.title)         $('fTitle').value    = d.title;
  if (d.location)      $('fLoc').value      = d.location;
  if (d.deadline)      $('fDeadline').value = d.deadline;
  if (d.notes_prefill) $('fNotes').value    = d.notes_prefill;
  if (url)             $('fUrl').value      = url;
  $('fDate').value = iso();
  if (d.bucket_guess) {
    for (const opt of $('fBucket').options) {
      if (opt.value === d.bucket_guess) { $('fBucket').value = d.bucket_guess; break; }
    }
  }
  // Open the form so user can review
  $('addSection').classList.add('open');
  $('addSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── API Key Modal ────────────────────────────────────────────────────────────
function updateDot() {
  $('apiDot').className = 'dot ' + (apiKey() ? 'dot-on' : 'dot-off');
}

$('apiKeyBtn').onclick = () => {
  $('apiKeyInp').value = apiKey() ? '(set — paste new to replace)' : '';
  $('apiOverlay').classList.remove('hidden');
  $('apiCancelBtn').classList.toggle('hidden', !apiKey());
};
$('apiCancelBtn').onclick = () => $('apiOverlay').classList.add('hidden');
$('apiSaveBtn').onclick = () => {
  const v = $('apiKeyInp').value.trim();
  if (!v || v.startsWith('(set')) { $('apiOverlay').classList.add('hidden'); return; }
  if (!v.startsWith('sk-ant-')) { alert('Key should start with sk-ant-'); return; }
  localStorage.setItem(LS_KEY, v);
  updateDot();
  $('apiOverlay').classList.add('hidden');
};

// ─── Add / Cancel Form ────────────────────────────────────────────────────────
$('openAddBtn').onclick = () => {
  $('addSection').classList.toggle('open');
  if ($('addSection').classList.contains('open')) $('fDate').value = iso();
};
$('cancelFormBtn').onclick = resetForm;

function resetForm() {
  ['fCo','fTitle','fLoc','fDeadline','fNotes','fUrl','urlInp'].forEach(id => $(id).value = '');
  $('fDate').value = iso();
  $('fStatus').value = 'Interested';
  $('fBucket').value = '';
  hideAlert('scrapeAlert');
  hideAlert('formAlert');
  $('addSection').classList.remove('open');
}

// ─── Scrape This Tab (reads the live rendered DOM — works on LinkedIn, Workday, etc.) ──
$('scrapeTabBtn').onclick = async () => {
  if (!apiKey()) {
    showAlert('scrapeAlert', 'error', 'No API key — click <strong>API Key</strong> in the header first.');
    return;
  }

  $('scrapeTabBtn').disabled = true;
  showAlert('scrapeAlert', 'info', 'Reading page…', true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url || /^(chrome|chrome-extension|about|edge):/.test(tab.url)) {
      throw new Error('Navigate to a job posting page first, then click this button.');
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Skip noisy elements, grab visible text from the rendered page
        const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','HEADER','FOOTER','NAV','ASIDE']);
        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent;
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          if (skip.has(node.tagName)) return '';
          if (getComputedStyle(node).display === 'none') return '';
          return Array.from(node.childNodes).map(walk).join(' ');
        }
        return walk(document.body).replace(/\s{2,}/g, ' ').trim().slice(0, 18000);
      }
    });

    const text = results?.[0]?.result || '';
    if (text.length < 80) throw new Error('Page content seems empty — make sure the job posting is fully loaded.');

    showAlert('scrapeAlert', 'info', 'Analyzing with Claude…', true);

    const d = await callClaude(`${EXTRACT_PROMPT}\n\nText:\n${text}`);
    fillForm(d, tab.url);

    showAlert('scrapeAlert', 'success',
      `Found: <strong>${esc(d.title||'?')}</strong> at <strong>${esc(d.company||'?')}</strong> — review and save below.`);

  } catch (err) {
    console.error(err);
    showAlert('scrapeAlert', 'error', esc(err.message));
  } finally {
    $('scrapeTabBtn').disabled = false;
  }
};

// ─── URL Scraper (CORS proxy fallback) ────────────────────────────────────────
$('fetchBtn').onclick = async () => {
  const url = $('urlInp').value.trim();
  if (!url) { showAlert('scrapeAlert', 'error', 'Paste a URL first.'); return; }
  if (!apiKey()) {
    showAlert('scrapeAlert', 'error', 'No API key set — click <strong>API Key</strong> first.');
    return;
  }

  $('fetchBtn').disabled = true;
  showAlert('scrapeAlert', 'info', 'Fetching page…', true);

  try {
    let html = '';
    const proxies = [
      async u => {
        const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error('allorigins ' + r.status);
        return (await r.json()).contents || '';
      },
      async u => {
        const r = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(u)}`, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error('corsproxy ' + r.status);
        return r.text();
      }
    ];
    let proxyErr = '';
    for (const proxy of proxies) {
      try { html = await proxy(url); if (html.length >= 80) break; }
      catch (e) { proxyErr = e.message; }
    }
    if (html.length < 80) throw new Error('Could not fetch page. Try the Scrape Tab button instead. Error: ' + proxyErr);

    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 18000);

    showAlert('scrapeAlert', 'info', 'Analyzing with Claude…', true);
    const d = await callClaude(`${EXTRACT_PROMPT}\n\nText:\n${text}`);
    fillForm(d, url);
    showAlert('scrapeAlert', 'success',
      `Found: <strong>${esc(d.title||'?')}</strong> at <strong>${esc(d.company||'?')}</strong> — review and save below.`);

  } catch (err) {
    console.error(err);
    showAlert('scrapeAlert', 'error', `Auto-fill failed: ${esc(err.message)}`);
    $('fUrl').value = url;
    $('fDate').value = iso();
  } finally {
    $('fetchBtn').disabled = false;
  }
};

// ─── Screenshot → Claude Vision ───────────────────────────────────────────────
$('imgInp').onchange = async () => {
  const files = Array.from($('imgInp').files);
  if (!files.length) return;
  if (!apiKey()) {
    showAlert('scrapeAlert', 'error', 'No API key — click <strong>API Key</strong> first.');
    return;
  }

  const label = $('imgLabel');
  label.style.opacity = '0.6';
  showAlert('scrapeAlert', 'info', `Reading ${files.length} screenshot${files.length > 1 ? 's' : ''}…`, true);

  try {
    const images = await Promise.all(files.map(f => new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = e => res({ data: e.target.result.split(',')[1], mediaType: f.type || 'image/png' });
      reader.onerror = rej;
      reader.readAsDataURL(f);
    })));

    showAlert('scrapeAlert', 'info', 'Analyzing with Claude…', true);

    const content = [
      ...images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
      { type: 'text', text: `${EXTRACT_PROMPT}\n\nTreat all ${images.length} screenshot(s) as one job posting.` }
    ];

    const d = await callClaude(content);
    fillForm(d, null);
    showAlert('scrapeAlert', 'success',
      `Found: <strong>${esc(d.title||'?')}</strong> at <strong>${esc(d.company||'?')}</strong> — review and save below.`);

  } catch (err) {
    console.error(err);
    showAlert('scrapeAlert', 'error', `Screenshot scan failed: ${esc(err.message)}`);
  } finally {
    label.style.opacity = '1';
    $('imgInp').value = '';
  }
};

// ─── Save Job ─────────────────────────────────────────────────────────────────
$('saveJobBtn').onclick = () => {
  const co    = $('fCo').value.trim();
  const title = $('fTitle').value.trim();
  if (!co || !title) {
    showAlert('formAlert', 'error', 'Company and Job Title are required.');
    return;
  }
  hideAlert('formAlert');

  jobs.unshift({
    id: uid(), co, title,
    loc:      $('fLoc').value.trim(),
    date:     $('fDate').value || iso(),
    deadline: $('fDeadline').value,
    status:   $('fStatus').value,
    bucket:   $('fBucket').value,
    url:      $('fUrl').value.trim(),
    notes:    $('fNotes').value.trim(),
    ts:       Date.now()
  });

  persist();
  render();
  resetForm();
};

// ─── Delete ───────────────────────────────────────────────────────────────────
function askDelete(id, co) {
  delId = id;
  $('delMsg').textContent = `Remove "${co}"? This cannot be undone.`;
  $('delOverlay').classList.remove('hidden');
}

$('delCancelBtn').onclick  = () => { $('delOverlay').classList.add('hidden'); delId = null; };
$('delConfirmBtn').onclick = () => {
  if (!delId) return;
  jobs = jobs.filter(j => j.id !== delId);
  persist(); render();
  $('delOverlay').classList.add('hidden'); delId = null;
};

// ─── Inline field update ──────────────────────────────────────────────────────
function updateField(id, field, val) {
  const j = jobs.find(j => j.id === id);
  if (!j) return;
  j[field] = val;
  persist();
  renderStats();
}

// ─── Table event delegation (CSP-safe — no inline handlers) ──────────────────
$('tbody').addEventListener('change', e => {
  if (!e.target.matches('.status-sel,.bucket-sel')) return;
  const id    = e.target.closest('tr').dataset.id;
  const field = e.target.classList.contains('status-sel') ? 'status' : 'bucket';
  updateField(id, field, e.target.value);
});

$('tbody').addEventListener('click', e => {
  const btn = e.target.closest('.del-btn');
  if (!btn) return;
  const tr = btn.closest('tr');
  askDelete(tr.dataset.id, tr.dataset.co);
});

// ─── Sorting ──────────────────────────────────────────────────────────────────
document.querySelectorAll('th[data-col]').forEach(th => {
  th.onclick = () => {
    const c = th.dataset.col;
    sortDir = (sortCol === c && sortDir === 'asc') ? 'desc' : 'asc';
    sortCol = c;
    render();
  };
});

function sorted(list) {
  return [...list].sort((a, b) => {
    const av = a[sortCol] || '', bv = b[sortCol] || '';
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

// ─── Filter ───────────────────────────────────────────────────────────────────
['fltStatus','fltBucket','fltSearch'].forEach(id => {
  $(id).addEventListener('input',  render);
  $(id).addEventListener('change', render);
});

function filtered() {
  const st = $('fltStatus').value;
  const bk = $('fltBucket').value;
  const q  = $('fltSearch').value.toLowerCase();
  return jobs.filter(j => {
    if (st && j.status !== st) return false;
    if (bk && j.bucket !== bk) return false;
    if (q && !`${j.co} ${j.title}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render() {
  const list  = sorted(filtered());
  const tbody = $('tbody');

  document.querySelectorAll('th[data-col]').forEach(th => {
    if (!th.dataset.label) th.dataset.label = th.textContent.trim();
    th.classList.toggle('sorted', th.dataset.col === sortCol);
    const arrow = th.dataset.col === sortCol ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    th.textContent = th.dataset.label + arrow;
  });

  $('countPill').textContent = list.length === jobs.length
    ? `${jobs.length}`
    : `${list.length} of ${jobs.length}`;

  if (list.length === 0) {
    tbody.innerHTML = '';
    $('emptyState').classList.remove('hidden');
    $('emptyState').querySelector('strong').textContent =
      jobs.length === 0 ? 'No applications yet' : 'No matches';
    $('emptyState').lastChild.textContent =
      jobs.length === 0
        ? ' Navigate to a job page and click ⚡ Scrape This Job Page to get started.'
        : ' Clear the filters to see all.';
    return;
  }

  $('emptyState').classList.add('hidden');

  const statusOpts = ['Interested','Applied','Phone Screen','Interview','Offer','Rejected'];
  const bucketOpts = ['','Capital Markets Advisory','Investment Sales Brokerage','Leasing Brokerage','Development'];

  tbody.innerHTML = list.map(j => {
    const coCell = j.url
      ? `<div class="co-name"><a href="${esc(j.url)}" target="_blank" rel="noopener" class="co-link">${esc(j.co)} ↗</a></div>`
      : `<div class="co-name">${esc(j.co)}</div>`;

    const statusSel = `<select class="tsel status-sel">
      ${statusOpts.map(s => `<option${j.status === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>`;

    const bucketSel = `<select class="tsel bucket-sel">
      ${bucketOpts.map(b => `<option value="${esc(b)}"${j.bucket === b ? ' selected' : ''}>${b || '—'}</option>`).join('')}
    </select>`;

    const dl      = j.deadline;
    const dlStyle = dl && dl < iso() ? 'color:var(--danger)' : '';

    return `<tr data-id="${j.id}" data-co="${esc(j.co)}">
      <td>${coCell}</td>
      <td>${esc(j.title)}</td>
      <td style="color:var(--muted);font-size:11px">${esc(j.loc) || '—'}</td>
      <td style="white-space:nowrap;font-size:11px">${fmt(j.date)}</td>
      <td style="white-space:nowrap;font-size:11px;${dlStyle}">${fmt(dl)}</td>
      <td>${statusSel}</td>
      <td style="font-size:11px">${bucketSel}</td>
      <td class="notes-td" title="${esc(j.notes)}">${esc(j.notes) || '—'}</td>
      <td><button class="btn btn-danger del-btn">✕</button></td>
    </tr>`;
  }).join('');

  renderStats();
}

function renderStats() {
  $('sTotal').textContent     = jobs.length;
  $('sActive').textContent    = jobs.filter(j => ['Applied','Phone Screen','Interview'].includes(j.status)).length;
  $('sInterview').textContent = jobs.filter(j => j.status === 'Interview').length;
  $('sOffer').textContent     = jobs.filter(j => j.status === 'Offer').length;
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
$('exportBtn').onclick = () => {
  if (!jobs.length) { alert('No applications to export.'); return; }
  const cols    = ['co','title','loc','date','deadline','status','bucket','url','notes'];
  const headers = ['Company','Title','Location','Date Found','Deadline','Status','Bucket','URL','Notes'];
  const q    = v => { const s = String(v||''); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g,'""')}"` : s; };
  const rows = [headers, ...jobs.map(j => cols.map(c => q(j[c])))];
  const csv  = rows.map(r => r.join(',')).join('\n');
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `cre-jobs-${iso()}.csv`;
  a.click();
};

// ─── Close overlays on backdrop click ────────────────────────────────────────
$('apiOverlay').onclick = e => { if (e.target === e.currentTarget) $('apiOverlay').classList.add('hidden'); };
$('delOverlay').onclick = e => { if (e.target === e.currentTarget) { $('delOverlay').classList.add('hidden'); delId = null; } };

// ─── Boot ─────────────────────────────────────────────────────────────────────
$('fDate').value = iso();
updateDot();
if (!apiKey()) {
  $('apiOverlay').classList.remove('hidden');
  $('apiCancelBtn').classList.add('hidden');
}
render();
