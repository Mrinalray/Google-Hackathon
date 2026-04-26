/* ================================================================
   ALETHIA — app.js
   Frontend logic — connects to backend at BACKEND_URL
   ================================================================ */

// ⚙️ UPDATE: Change this to your backend URL when deploying
const BACKEND_URL = 'http://localhost:3001';

/* ── STATE ───────────────────────────────────────────────────── */
let currentFile = null;
let currentMode = null; // 'image' | 'video' | 'audio' | 'url'
let urlModeActive = false;

/* ── INIT ────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setupDragDrop();
  updateBackendStatus();
});

async function updateBackendStatus() {
  const el = document.getElementById('backendStatus');
  try {
    const r = await fetch(`${BACKEND_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      el.innerHTML = `<span class="mono" style="color:var(--green)">● connected</span>`;
    } else {
      el.innerHTML = `<span class="mono" style="color:var(--warn)">⚠ backend error</span>`;
    }
  } catch {
    el.innerHTML = `<span class="mono" style="color:var(--danger)">✕ not connected</span>`;
  }
}

/* ── URL TOGGLE ──────────────────────────────────────────────── */
function toggleUrl() {
  urlModeActive = !urlModeActive;
  const row = document.getElementById('urlRow');
  const btn = document.getElementById('urlToggle');
  row.style.display = urlModeActive ? 'flex' : 'none';
  btn.classList.toggle('active', urlModeActive);
  if (urlModeActive && currentFile) clearMedia();
}

/* ── FILE HANDLING ───────────────────────────────────────────── */
function handleFile(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  setMedia(file, type);
  event.target.value = '';
}

function setMedia(file, type) {
  currentFile = file;
  currentMode = type;

  // Hide URL mode if switching
  if (urlModeActive) toggleUrl();

  const previewArea = document.getElementById('previewArea');
  const previewInner = document.getElementById('previewInner');

  previewArea.style.display = 'block';
  previewInner.innerHTML = '';

  if (type === 'image') {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    previewInner.appendChild(img);
  } else if (type === 'video') {
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(file);
    vid.controls = true;
    previewInner.appendChild(vid);
  } else if (type === 'audio') {
    const chip = document.createElement('div');
    chip.className = 'audio-chip';
    chip.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4 L4 12 M6 2 L6 14 M8 5 L8 11 M10 2 L10 14 M12 4 L12 12" stroke="var(--accent)" stroke-width="1.2" stroke-linecap="round"/></svg> <span>${file.name}</span>`;
    const audio = document.createElement('audio');
    audio.src = URL.createObjectURL(file);
    audio.controls = true;
    audio.style.cssText = 'width:100%;margin-top:8px;';
    const wrap = document.createElement('div');
    wrap.appendChild(chip);
    wrap.appendChild(audio);
    previewInner.appendChild(wrap);
  }
}

function clearMedia() {
  currentFile = null;
  currentMode = null;
  document.getElementById('previewArea').style.display = 'none';
  document.getElementById('previewInner').innerHTML = '';
  // Reset file inputs
  ['fileImg','fileVideo','fileAudio'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

/* ── DRAG & DROP ─────────────────────────────────────────────── */
function setupDragDrop() {
  const box = document.getElementById('inputBox');
  const overlay = document.getElementById('dragOverlay');

  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    box.classList.add('drag-active');
    overlay.classList.add('active');
  });

  box.addEventListener('dragleave', (e) => {
    if (!box.contains(e.relatedTarget)) {
      box.classList.remove('drag-active');
      overlay.classList.remove('active');
    }
  });

  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag-active');
    overlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const type = file.type.startsWith('video/') ? 'video'
               : file.type.startsWith('audio/') ? 'audio'
               : 'image';
    setMedia(file, type);
  });
}

/* ── ANALYSIS ────────────────────────────────────────────────── */
async function startAnalysis() {
  const urlVal = document.getElementById('urlInput').value.trim();

  // Validate input
  if (!currentFile && !urlVal) {
    shakeInputBox();
    return;
  }

  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true;

  // Show results area + loading
  document.getElementById('resultsArea').style.display = 'block';
  document.getElementById('loadingPanel').style.display = 'flex';
  document.getElementById('resultsContent').style.display = 'none';

  // Scroll to results
  setTimeout(() => {
    document.getElementById('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);

  // Animate loading steps
  const steps = [
    'Establishing secure connection...',
    'Uploading media to analysis engine...',
    'Running SightEngine forensics...',
    'Querying Gemini visual intelligence...',
    'Synthesizing verdict...'
  ];
  animateSteps(steps);

  try {
    let result;
    if (urlVal) {
      result = await analyzeUrl(urlVal);
    } else {
      result = await analyzeFile(currentFile);
    }
    showResults(result);
  } catch (err) {
    showError(err.message || 'Analysis failed. Is the backend running?');
  } finally {
    btn.disabled = false;
  }
}

async function analyzeFile(file) {
  const formData = new FormData();
  formData.append('image', file); // ⚙️ UPDATE: change 'image' key if backend uses different field name
  const r = await fetch(`${BACKEND_URL}/api/analyze/upload`, {
    method: 'POST',
    body: formData
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Server error' }));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

async function analyzeUrl(url) {
  const r = await fetch(`${BACKEND_URL}/api/analyze/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'Server error' }));
    throw new Error(err.error || `HTTP ${r.status}`);
  }
  return r.json();
}

/* ── LOADING ANIMATION ───────────────────────────────────────── */
let stepTimers = [];

function animateSteps(steps) {
  const container = document.getElementById('loadingStepsList');
  container.innerHTML = '';
  stepTimers.forEach(clearTimeout);
  stepTimers = [];

  steps.forEach((text, i) => {
    const div = document.createElement('div');
    div.className = 'loading-step';
    div.innerHTML = `<div class="step-indicator"></div><span>${text}</span>`;
    container.appendChild(div);
  });

  const els = container.querySelectorAll('.loading-step');
  let current = 0;

  function advance() {
    if (current > 0) els[current - 1].className = 'loading-step done';
    if (current < els.length) {
      els[current].className = 'loading-step active';
      current++;
      if (current < els.length) {
        stepTimers.push(setTimeout(advance, 900 + Math.random() * 400));
      }
    }
  }

  advance();
}

/* ── SHOW RESULTS ────────────────────────────────────────────── */
/*
  ⚙️ UPDATE: The result object from the backend should have this shape:
  {
    aiProbability: number (0–100),   // AI likelihood
    verdict: 'ai' | 'real' | 'uncertain',
    confidence: 'High' | 'Medium' | 'Low',
    estimatedGenerator: string,      // e.g. 'Midjourney', 'DALL·E', 'Unknown'
    summary: string,
    aiIndicators: [{ name, severity, description }],
    realIndicators: [{ name, severity, description }],
    technicalDetails: string
  }
*/
function showResults(data) {
  document.getElementById('loadingPanel').style.display = 'none';
  document.getElementById('resultsContent').style.display = 'flex';

  const ai = Math.round(data.aiProbability ?? 50);
  const real = 100 - ai;
  const verdict = data.verdict || (ai > 70 ? 'ai' : ai < 40 ? 'real' : 'uncertain');

  // Verdict header class
  const header = document.getElementById('verdictHeader');
  header.className = `verdict-header verdict-${verdict}`;

  // Verdict icon + text
  const icons = { ai: '🤖', real: '✓', uncertain: '⚠' };
  const labels = { ai: 'AI GENERATED', real: 'AUTHENTIC', uncertain: 'UNCERTAIN' };
  document.getElementById('verdictIcon').textContent = icons[verdict] || '⚠';
  const mainEl = document.getElementById('verdictMain');
  mainEl.textContent = labels[verdict] || verdict.toUpperCase();
  mainEl.className = 'verdict-main';

  // Scale needle (ai probability on right side)
  setTimeout(() => {
    document.getElementById('scaleNeedle').style.left = `${ai}%`;
  }, 100);

  document.getElementById('realPct').textContent = `${real}%`;
  document.getElementById('aiPct').textContent = `${ai}%`;

  // Meta
  document.getElementById('confidenceVal').textContent = data.confidence || '—';
  document.getElementById('generatorVal').textContent = data.estimatedGenerator || '—';
  document.getElementById('mediaTypeVal').textContent = data.mediaType || currentMode?.toUpperCase() || '—';

  // Summary
  document.getElementById('summaryText').textContent = data.summary || 'No summary available.';

  // AI Indicators
  const aiSec = document.getElementById('aiSection');
  const aiList = document.getElementById('aiIndicators');
  aiList.innerHTML = '';
  if (data.aiIndicators?.length) {
    data.aiIndicators.forEach(ind => aiList.appendChild(buildIndicator(ind, 'ai-ind')));
    aiSec.style.display = 'block';
  } else {
    aiSec.style.display = 'none';
  }

  // Real Indicators
  const realSec = document.getElementById('realSection');
  const realList = document.getElementById('realIndicators');
  realList.innerHTML = '';
  if (data.realIndicators?.length) {
    data.realIndicators.forEach(ind => realList.appendChild(buildIndicator(ind, 'real-ind')));
    realSec.style.display = 'block';
  } else {
    realSec.style.display = 'none';
  }

  // Technical
  document.getElementById('technicalText').textContent = data.technicalDetails || '— No technical data —';
}

function buildIndicator(ind, cls) {
  const div = document.createElement('div');
  div.className = `indicator ${cls}`;
  div.innerHTML = `
    <div class="ind-top">
      <span class="ind-name">${ind.name || 'Unknown'}</span>
      <span class="sev-badge ${ind.severity || 'Medium'}">${ind.severity || 'Medium'}</span>
    </div>
    <p class="ind-desc">${ind.description || ''}</p>
  `;
  return div;
}

function showError(msg) {
  document.getElementById('loadingPanel').style.display = 'none';
  const content = document.getElementById('resultsContent');
  content.style.display = 'flex';
  content.innerHTML = `
    <div style="padding:24px;background:rgba(255,60,92,0.07);border:1px solid rgba(255,60,92,0.3);border-radius:12px;color:var(--danger);font-family:var(--font-mono);font-size:13px;line-height:1.6;">
      <div style="font-size:11px;letter-spacing:2px;margin-bottom:8px;color:var(--text3)">ERROR</div>
      ${msg}
    </div>
    <button class="reset-btn" onclick="resetAll()">↺ Try Again</button>
  `;
}

/* ── RESET ───────────────────────────────────────────────────── */
function resetAll() {
  clearMedia();
  document.getElementById('urlInput').value = '';
  if (urlModeActive) toggleUrl();
  document.getElementById('resultsArea').style.display = 'none';
  document.getElementById('loadingPanel').style.display = 'none';
  document.getElementById('resultsContent').style.display = 'none';
  document.getElementById('resultsContent').innerHTML = `
    <div class="result-card" id="aiSection"><div class="card-head"><div class="card-icon warn-icon"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1.5 L13 12 L1 12 Z" stroke="currentColor" stroke-width="1.2" fill="none"/><line x1="7" y1="5.5" x2="7" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="7" cy="10" r="0.5" fill="currentColor"/></svg></div>AI ARTIFACTS DETECTED</div><div class="indicators" id="aiIndicators"></div></div>
    <div class="result-card" id="realSection"><div class="card-head"><div class="card-icon ok-icon"><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 7 L6.5 9 L9.5 5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>AUTHENTIC SIGNALS</div><div class="indicators" id="realIndicators"></div></div>
  `;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── SHAKE ANIMATION ─────────────────────────────────────────── */
function shakeInputBox() {
  const box = document.getElementById('inputBox');
  box.style.animation = 'none';
  box.style.transition = 'transform 0.05s';
  const positions = [0, -6, 6, -6, 6, -4, 4, 0];
  let i = 0;
  const interval = setInterval(() => {
    box.style.transform = `translateX(${positions[i]}px)`;
    i++;
    if (i >= positions.length) {
      clearInterval(interval);
      box.style.transform = '';
    }
  }, 50);
}