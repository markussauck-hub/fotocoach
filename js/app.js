// Foto-Coach – Hauptlogik: Aufnahme -> (Panorama) -> KI-Analyse -> Ergebnis
import { analyze, judge, GeminiError } from './gemini.js?v=0.4.10';
import { measure, readExif, describe } from './measure.js?v=0.4.10';
import { saveSession, loadSession } from './session.js?v=0.4.10';
import { progress } from './progress.js?v=0.4.10';
import { cleanKey, looksLikeKey, testKey, probeProxy, readClipboard, handoverUrl, qrSvg, takeKeyFromHash } from './keys.js?v=0.4.10';

const $ = (s) => document.querySelector(s);
const MAX_PHOTOS = 8;
const STITCH_LONG = 1600;   // Arbeitsauflösung fürs Stitching (lange Seite)
const SINGLE_LONG = 2048;   // Einzelfoto für Anzeige + KI
const PANO_LONG_AI = 3072;  // Panorama-Breite, die an die KI geht

/* ---------- Einstellungen ---------- */
const DEFAULTS = { key: '', model: 'gemini-3.6-flash', count: 5, ghost: true, fallback: true, thinking: 'low' };
const store = {
  get() {
    let v;
    try { v = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('fotocoach.settings') || '{}') }; } catch (_) { return { ...DEFAULTS }; }
    // v0.4.2: Standard ist jetzt 3.6 Flash (3.8 oft überlastet) – alte Standardwahl einmalig umstellen
    if (!v.sv) { if (v.model === 'gemini-3.8-flash') v.model = 'gemini-3.6-flash'; v.sv = 2; }
    return v;
  },
  set(v) { try { localStorage.setItem('fotocoach.settings', JSON.stringify(v)); } catch (_) {} },
};
let settings = store.get();

/* ---------- Zustand ---------- */
const state = {
  photos: [],        // { id, blob, url }
  stream: null,
  lastBitmap: null,  // für Überlappungshilfe
  worker: null,
  abort: null,
  run: 0,            // laufende Auswertung (zum Abbrechen)
  results: [],       // { canvas (Basisbild), label, indices, wide }
  notes: [],
  prepared: null,    // zwischengespeichertes Panorama { key, results, notes }
  motifs: [],
  selected: 0,
  proxy: false,      // Server-Proxy erreichbar -> kein Schlüssel nötig
  gesamteindruck: '',
  resultNotes: [],
  attempts: {},      // Lernschleife: { [motivNr]: [Versuch, …] }
  view: {},          // { [motivNr]: Index des angezeigten Versuchs }
};

/* ---------- Bildschirme ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  window.scrollTo({ top: 0 });
  if (id === 'screen-capture') startCamera(); else stopCamera();
}

/* ---------- Kamera ---------- */
const video = $('#video');
const ghost = $('#ghost');

async function startCamera() {
  if (state.stream) return;
  const fb = $('#vf-fallback');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    fb.hidden = false;
    $('#vf-fallback-text').textContent = window.isSecureContext
      ? 'Dieser Browser erlaubt keinen Kamerazugriff. Nutze die Kamera-App oder die Galerie.'
      : 'Der Live-Sucher braucht eine HTTPS-Verbindung. Nutze die Kamera-App oder die Galerie.';
    $('#btn-shutter').disabled = true;
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    if (!document.getElementById('screen-capture').classList.contains('active')) { stream.getTracks().forEach(t => t.stop()); return; }
    state.stream = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
    fb.hidden = true;
    $('#btn-shutter').disabled = false;
    drawGhost();
  } catch (e) {
    fb.hidden = false;
    $('#vf-fallback-text').textContent = (e && e.name === 'NotAllowedError')
      ? 'Kamerazugriff wurde nicht erlaubt. Du kannst die Kamera-App oder die Galerie nutzen – oder den Zugriff in den Browser-Einstellungen freigeben.'
      : 'Keine Kamera gefunden. Nutze die Kamera-App oder die Galerie.';
    $('#btn-shutter').disabled = true;
  }
}

function stopCamera() {
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  video.srcObject = null;
}

// Überlappungshilfe: rechtes Drittel des letzten Fotos halbtransparent links im Sucher
function drawGhost() {
  const vf = $('#viewfinder');
  const cw = vf.clientWidth, ch = vf.clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ghost.width = Math.round(cw * dpr); ghost.height = Math.round(ch * dpr);
  const g = ghost.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  const show = settings.ghost && state.lastBitmap && state.stream;
  $('#vf-guide').hidden = !show;
  if (!show) return;
  const vw = video.videoWidth || state.lastBitmap.width, vh = video.videoHeight || state.lastBitmap.height;
  const s = Math.max(cw / vw, ch / vh), dw = vw * s, dh = vh * s, ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  const b = state.lastBitmap;
  g.globalAlpha = 0.42;
  g.drawImage(b, b.width * 2 / 3, 0, b.width / 3, b.height, ox, oy, dw / 3, dh);
  g.globalAlpha = 1;
}
window.addEventListener('resize', () => drawGhost());

async function capture() {
  if (!state.stream || !video.videoWidth) return;
  if (state.photos.length >= MAX_PHOTOS) { toastHint(`Maximal ${MAX_PHOTOS} Fotos.`); return; }
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  if (navigator.vibrate) navigator.vibrate(30);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  addPhoto(blob);
}

async function addPhoto(blob) {
  if (state.photos.length >= MAX_PHOTOS) { toastHint(`Maximal ${MAX_PHOTOS} Fotos – weitere wurden ignoriert.`); return; }
  const photo = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), blob, url: URL.createObjectURL(blob) };
  state.photos.push(photo);
  try {
    const bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const s = Math.min(1, 900 / Math.max(bm.width, bm.height));
    state.lastBitmap = await createImageBitmap(bm, { resizeWidth: Math.round(bm.width * s), resizeHeight: Math.round(bm.height * s) });
    bm.close && bm.close();
  } catch (_) { /* Vorschau egal */ }
  renderThumbs();
  drawGhost();
  if (state.photos.length === 2) warmupWorker(); // OpenCV schon mal laden
}

function removePhoto(id) {
  const i = state.photos.findIndex(p => p.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(state.photos[i].url);
  state.photos.splice(i, 1);
  renderThumbs();
  if (!state.photos.length) { state.lastBitmap = null; drawGhost(); }
}

function renderThumbs() {
  const ol = $('#thumbs');
  ol.replaceChildren(...state.photos.map((p, i) => {
    const li = document.createElement('li');
    const img = document.createElement('img'); img.src = p.url; img.alt = `Foto ${i + 1}`;
    const n = document.createElement('span'); n.className = 'tnum'; n.textContent = i + 1;
    const del = document.createElement('button'); del.className = 'tdel'; del.type = 'button'; del.textContent = '×';
    del.setAttribute('aria-label', `Foto ${i + 1} entfernen`);
    del.addEventListener('click', () => removePhoto(p.id));
    li.append(img, n, del);
    return li;
  }));
  $('#photo-count').textContent = state.photos.length;
  $('#btn-next').disabled = state.photos.length === 0;
  $('#cap-hint').textContent = state.photos.length === 0
    ? 'Ein Foto reicht. Für ein Panorama: auf der Stelle stehen bleiben, von links nach rechts drehen und jedes Foto etwa ein Drittel überlappen lassen.'
    : state.photos.length === 1
      ? '👉 Fertig? Tippe auf „Auswerten“. – Für ein Panorama stattdessen etwas nach rechts drehen, bis die gestrichelte Linie am Ende der eingeblendeten Fläche liegt, und noch ein Foto machen.'
      : `👉 ${state.photos.length} Fotos – daraus wird ein Panorama. Tippe auf „Auswerten“ oder dreh weiter für mehr.`;
  $('#btn-next').classList.toggle('ready', state.photos.length > 0);
}

let hintTimer = 0;
function toastHint(text) {
  const h = $('#cap-hint'); const old = h.textContent; h.textContent = text;
  clearTimeout(hintTimer); hintTimer = setTimeout(() => renderThumbs(), 3500);
  return old;
}

/* ---------- Worker (Panorama) ---------- */
function getWorker() {
  if (!state.worker) state.worker = new Worker('js/stitch-worker.js');
  return state.worker;
}
function warmupWorker() { try { getWorker().postMessage({ type: 'warmup' }); } catch (_) {} }

function stitch(images) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      const d = e.data;
      if (d.type === 'progress') { setStatus(d.text); return; }
      if (d.type === 'ready') return;
      w.removeEventListener('message', onMsg);
      if (d.type === 'error') reject(new Error(d.message)); else resolve(d.result);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ type: 'stitch', images, opts: {} }, images.map(i => i.data.buffer));
  });
}

/* ---------- Bildhelfer ---------- */
async function decode(blob, long) {
  const bm = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const s = Math.min(1, long / Math.max(bm.width, bm.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bm.width * s); c.height = Math.round(bm.height * s);
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(bm, 0, 0, c.width, c.height);
  bm.close && bm.close();
  return c;
}
function canvasToBase64(canvas, long) {
  let src = canvas;
  const s = Math.min(1, long / Math.max(canvas.width, canvas.height));
  if (s < 1) {
    src = document.createElement('canvas');
    src.width = Math.round(canvas.width * s); src.height = Math.round(canvas.height * s);
    const g = src.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, src.width, src.height);
  }
  return src.toDataURL('image/jpeg', 0.85).split(',')[1];
}

/* ---------- Ablauf ---------- */
function setStep(step, cls) {
  const li = document.querySelector(`#steps li[data-step="${step}"]`);
  if (!li) return;
  li.classList.remove('active', 'done', 'skip');
  if (cls) li.classList.add(cls);
}
function setStatus(t) { $('#work-status').textContent = t; }

// Signatur der aktuellen Fotos – solange sie gleich bleibt, wird das Panorama wiederverwendet
const photoKey = () => state.photos.map(p => p.id).join('|');

async function runPipeline({ reuse = false } = {}) {
  const run = ++state.run;
  const alive = () => run === state.run;
  show('screen-work');
  ['prep', 'pano', 'ai'].forEach(s => setStep(s, null));
  $('#work-title').textContent = 'Wird ausgewertet';
  const multi = state.photos.length > 1;
  const cached = reuse && state.prepared && state.prepared.key === photoKey();
  try {
    if (cached) {
      state.results = state.prepared.results;
      setStep('prep', 'done'); setStep('pano', multi ? 'done' : 'skip');
    } else {
      $('#work-preview').replaceChildren();
      state.prepared = null;
      await prepare(alive);
      if (!alive()) return;
      state.prepared = { key: photoKey(), results: state.results, notes: state.notes };
    }

    setStep('ai', 'active');
    progress.start('analyze');
    state.abort = new AbortController();
    const images = state.results.map(r => ({ base64: canvasToBase64(r.canvas, r.wide ? PANO_LONG_AI : SINGLE_LONG), label: r.label }));
    const { out, model } = await analyzeResilient(images, state.abort.signal, alive);
    if (!alive()) return;
    progress.done('analyze');
    setStep('ai', 'done');
    const notes = [...state.prepared.notes];
    if (model !== settings.model) notes.push(`${modelName(settings.model)} war überlastet – ausgewertet mit ${modelName(model)}.`);
    renderResult(out, notes);
  } catch (e) {
    progress.stop('analyze');
    if (!alive() || (e && e.name === 'AbortError')) return;
    renderError(e);
  }
}

async function prepare(alive) {
  const multi = state.photos.length > 1;
  setStep('prep', 'active'); setStatus('Fotos werden vorbereitet …');
  state.results = [];
  state.notes = [];
  if (!multi) {
    const c = await decode(state.photos[0].blob, SINGLE_LONG);
    if (!alive()) return;
    state.results.push({ canvas: c, label: 'Foto', indices: [0], wide: false });
    setStep('prep', 'done'); setStep('pano', 'skip');
    return;
  }
  const imgs = [];
  for (const p of state.photos) {
    const c = await decode(p.blob, STITCH_LONG);
    imgs.push(c.getContext('2d').getImageData(0, 0, c.width, c.height));
  }
  if (!alive()) return;
  setStep('prep', 'done'); setStep('pano', 'active');
  const r = await stitch(imgs);
  if (!alive()) return;
  for (const g of r.groups) {
    if (g.panorama) {
      const p = g.panorama;
      const c = document.createElement('canvas'); c.width = p.width; c.height = p.height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
      state.results.push({ canvas: c, label: `Panorama aus Foto ${range(g.indices)}`, indices: g.indices, wide: c.width / c.height > 1.9 });
    } else {
      const c = await decode(state.photos[g.indices[0]].blob, SINGLE_LONG);
      state.results.push({ canvas: c, label: `Foto ${g.indices[0] + 1}`, indices: g.indices, wide: false });
    }
  }
  const fails = r.log.filter(l => !l.ok);
  if (fails.length) {
    state.notes.push(fails.map(f => `Foto ${f.from + 1} ließ sich nicht an Foto ${f.to + 1} anschließen`).join(', ') +
      ' – zu wenig Überlappung. Diese Fotos werden einzeln ausgewertet.');
  }
  setStep('pano', 'done');
  const first = state.results.find(x => x.indices.length > 1);
  if (first) { const img = new Image(); img.src = first.canvas.toDataURL('image/jpeg', 0.7); img.alt = 'Panorama-Vorschau'; $('#work-preview').replaceChildren(img); }
}

/* Gemini mit Wiederholung + Ausweich-Modell:
 *  - 500/502/503/504 (überlastet): 2 Versuche pro Modell (4 s Pause), dann nächstes Modell
 *  - 429 (Kontingent) oder 404 (Modell weg): sofort nächstes Modell
 *  - alles andere (Schlüssel falsch usw.): sofort abbrechen */
const MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];
const WAITS = [4]; // ein Wiederholversuch pro Modell, dann Wechsel
const modelName = (m) => ({ 'gemini-3.8-flash': 'Gemini 3.8 Flash', 'gemini-3.6-flash': 'Gemini 3.6 Flash', 'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite' }[m] || m);

async function analyzeResilient(images, signal, alive) {
  const what = `schaut sich ${images.length > 1 ? 'die Bilder' : 'das Bild'} an …`;
  return withFallback((model) => analyze(images, { key: settings.key, model, count: settings.count, thinking: settings.thinking, signal }), setStatus, signal, alive, what,
    { kind: 'analyze', prog: 'analyze' });
}

// Ruft call(model) mit Wiederholung + Ausweich-Modell auf; Statusmeldungen gehen an status(text)
async function withFallback(call, status, signal, alive, what, { kind, prog } = {}) {
  const chain = [settings.model, ...(settings.fallback ? MODELS.filter(m => m !== settings.model) : [])];
  let lastErr = null;
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    for (let attempt = 0; attempt <= WAITS.length; attempt++) {
      status(`${modelName(model)} ${what}` + (attempt ? ` (Versuch ${attempt + 1})` : ''));
      try {
        if (prog) progress.model(prog, kind, model, settings.thinking);
        const t0 = performance.now();
        const out = await call(model);
        if (kind) progress.record(kind, model, settings.thinking, (performance.now() - t0) / 1000);
        return { out, model };
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
        const st = e instanceof GeminiError ? e.status : 0;
        const overloaded = st >= 500 || st === 0;
        const switchModel = st === 429 || (st === 404 && !!settings.key);
        if (overloaded && attempt < WAITS.length) {
          await countdown(WAITS[attempt], `${modelName(model)} ist überlastet`, signal, alive, status);
          continue;
        }
        if (overloaded || switchModel) break; // nächstes Modell
        throw e;                               // Schlüssel/Proxy-Problem: Wechsel hilft nicht
      }
    }
    if (mi < chain.length - 1) status(`Wechsle zu ${modelName(chain[mi + 1])} …`);
  }
  if (lastErr instanceof GeminiError && lastErr.status >= 500) {
    throw new GeminiError('Gemini ist gerade bei allen Modellen überlastet. Deine Fotos bleiben erhalten – versuch es in ein paar Minuten nochmal.', { status: lastErr.status, retry: true });
  }
  throw lastErr;
}

function countdown(sec, text, signal, alive, status = setStatus) {
  return new Promise((resolve, reject) => {
    let left = sec;
    const tick = () => {
      if (signal.aborted || !alive()) { clearInterval(iv); reject(new DOMException('abgebrochen', 'AbortError')); return; }
      if (left <= 0) { clearInterval(iv); resolve(); return; }
      status(`${text} – neuer Versuch in ${left} s …`);
      left--;
    };
    const iv = setInterval(tick, 1000);
    tick();
  });
}

const range = (idx) => idx.length > 1 ? `${idx[0] + 1}–${idx[idx.length - 1] + 1}` : `${idx[0] + 1}`;

function cancelRun() {
  state.run++;
  progress.stop('analyze');
  if (state.abort) state.abort.abort();
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  show('screen-capture');
}

/* ---------- Ergebnis ---------- */
function renderError(e) {
  show('screen-result');
  $('#result-images').replaceChildren();
  $('#motifs').replaceChildren();
  $('#summary').hidden = true;
  $('#btn-save').hidden = true; $('#btn-share').hidden = true;
  $('#result-error').hidden = false;
  $('#result-error-text').textContent = (e && e.message) || 'Unbekannter Fehler.';
  lastError = `${new Date().toLocaleTimeString('de-DE')} Auswertung: ${(e && e.message) || 'Unbekannter Fehler'}${e && e.status ? ` (HTTP ${e.status})` : ''}`;
  $('#btn-retry').hidden = e instanceof GeminiError ? !e.retry && !e.settings : false;
  $('#btn-error-settings').hidden = !(e instanceof GeminiError && e.settings);
  $('#btn-error-settings').textContent = hasAi() ? 'Einstellungen' : 'Einrichten';
  // Bilder trotzdem zeigen, falls schon vorhanden
  if (state.results.length) { state.motifs = []; renderImages(); }
}

function renderResult(out, notes, { fresh = true } = {}) {
  show('screen-result');
  $('#result-error').hidden = true;
  state.motifs = out.motive;
  state.selected = 0;
  state.gesamteindruck = out.gesamteindruck || '';
  state.resultNotes = notes;
  if (fresh) { abortAttempts(); state.attempts = {}; state.view = {}; }
  const sum = $('#summary');
  sum.hidden = false;
  const p = document.createElement('p'); p.textContent = out.gesamteindruck || 'Hier sind die stärksten Motive.';
  const prog = document.createElement('p'); prog.className = 'practice-progress'; prog.id = 'practice-progress';
  sum.replaceChildren(p, prog);
  renderImages(notes);
  renderMotifs();
  updateProgress();
  if (fresh) persist();
  $('#btn-save').hidden = false;
  $('#btn-share').hidden = !(navigator.canShare && navigator.share);
}

function renderImages(notes = []) {
  const wrap = $('#result-images');
  const nodes = [];
  notes.forEach(n => { const d = document.createElement('p'); d.className = 'note'; d.textContent = n; nodes.push(d); });
  state.results.forEach((r, i) => {
    const fig = document.createElement('figure'); fig.className = 'result-figure'; fig.id = `fig-${i}`;
    const cap = document.createElement('figcaption');
    const a = document.createElement('span'); a.textContent = state.results.length > 1 ? `Bild ${i + 1} · ${r.label}` : r.label;
    const b = document.createElement('span'); b.className = 'num'; b.textContent = `${r.canvas.width}×${r.canvas.height}`;
    cap.append(a, b);
    const sc = document.createElement('div'); sc.className = 'scroller' + (r.wide ? ' wide' : '');
    const cv = document.createElement('canvas'); cv.id = `img-${i}`;
    cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', `${r.label} mit markierten Motiven`);
    sc.append(cv);
    fig.append(cap, sc);
    if (r.wide) { const h = document.createElement('div'); h.className = 'swipe-hint'; h.textContent = '← wischen zum Erkunden →'; fig.append(h); }
    nodes.push(fig);
    cv.addEventListener('click', (ev) => pickAt(i, cv, ev));
  });
  wrap.replaceChildren(...nodes);
  state.results.forEach((_, i) => drawAnnotated(i));
}

function boxPx(m, c) {
  return { x0: m.box.x0 / 1000 * c.width, x1: m.box.x1 / 1000 * c.width, y0: m.box.y0 / 1000 * c.height, y1: m.box.y1 / 1000 * c.height };
}

function drawAnnotated(i, target) {
  const r = state.results[i];
  const base = r.canvas;
  const cv = target || document.getElementById(`img-${i}`);
  if (!cv) return;
  cv.width = base.width; cv.height = base.height;
  const g = cv.getContext('2d');
  g.drawImage(base, 0, 0);
  const L = Math.max(base.width, base.height);
  const lw = Math.max(4, Math.round(Math.min(base.width, base.height) * 0.011));
  const motifs = state.motifs.filter(m => m.bild === i + 1);
  // ausgewähltes Motiv zuletzt (obenauf)
  motifs.sort((a, b) => (a.nr === state.selected) - (b.nr === state.selected));
  for (const m of motifs) {
    const b = boxPx(m, base);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const ax = Math.max(L * 0.02, (b.x1 - b.x0) / 2 * 1.15), ay = Math.max(L * 0.02, (b.y1 - b.y0) / 2 * 1.15);
    const sel = !target && m.nr === state.selected;
    const color = sel ? '#3ee6ff' : '#ffd21f';
    g.lineJoin = 'round';
    g.beginPath(); g.ellipse(cx, cy, ax, ay, 0, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = lw * 1.9; g.stroke();
    g.strokeStyle = color; g.lineWidth = sel ? lw * 1.25 : lw; g.stroke();
    // Nummer oben links auf dem Ring
    const rad = Math.max(16, Math.round(Math.min(base.width, base.height) * 0.04));
    let bx = cx - ax * 0.7071, by = cy - ay * 0.7071;
    bx = Math.max(rad + 2, Math.min(base.width - rad - 2, bx)); by = Math.max(rad + 2, Math.min(base.height - rad - 2, by));
    g.beginPath(); g.arc(bx, by, rad + lw * 0.45, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
    g.beginPath(); g.arc(bx, by, rad, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    g.fillStyle = '#111';
    g.font = `700 ${Math.round(rad * 1.15)}px "Martian Mono", ui-monospace, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(m.nr), bx, by + rad * 0.06);
    if (!target && isDone(m.nr)) {            // fotografiert: grünes Häkchen am Abzeichen
      const cr = rad * 0.55, chx = bx + rad * 0.85, chy = by - rad * 0.85;
      g.beginPath(); g.arc(chx, chy, cr + lw * 0.35, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
      g.beginPath(); g.arc(chx, chy, cr, 0, Math.PI * 2); g.fillStyle = '#4ee38a'; g.fill();
      g.beginPath(); g.moveTo(chx - cr * 0.45, chy); g.lineTo(chx - cr * 0.1, chy + cr * 0.38); g.lineTo(chx + cr * 0.5, chy - cr * 0.35);
      g.strokeStyle = '#111'; g.lineWidth = Math.max(2, cr * 0.28); g.lineCap = 'round'; g.stroke(); g.lineCap = 'butt';
    }
  }
}

function pickAt(i, cv, ev) {
  const rect = cv.getBoundingClientRect();
  const x = (ev.clientX - rect.left) / rect.width * 1000, y = (ev.clientY - rect.top) / rect.height * 1000;
  const hit = state.motifs.filter(m => m.bild === i + 1 && x >= m.box.x0 && x <= m.box.x1 && y >= m.box.y0 && y <= m.box.y1)
    .sort((a, b) => (a.box.x1 - a.box.x0) * (a.box.y1 - a.box.y0) - (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0))[0];
  if (hit) { select(hit.nr, false); document.getElementById(`motif-${hit.nr}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}

function select(nr, scrollImage = true) {
  state.selected = nr;
  document.querySelectorAll('.motif').forEach(el => el.classList.toggle('selected', Number(el.dataset.nr) === nr));
  state.results.forEach((_, i) => drawAnnotated(i));
  const m = state.motifs.find(x => x.nr === nr);
  if (!m || !scrollImage) return;
  const fig = document.getElementById(`fig-${m.bild - 1}`);
  const cv = document.getElementById(`img-${m.bild - 1}`);
  if (fig) fig.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const sc = cv && cv.parentElement;
  if (sc && sc.scrollWidth > sc.clientWidth) {
    const cx = (m.box.x0 + m.box.x1) / 2000 * cv.clientWidth;
    sc.scrollTo({ left: Math.max(0, cx - sc.clientWidth / 2), behavior: 'smooth' });
  }
}

const ICONS = {
  perspektive: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  bildaufbau: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>',
  kamera: '<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="4"/></svg>',
  licht: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  standort: '<svg viewBox="0 0 24 24"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
};
const TIP_LABELS = { perspektive: 'Perspektive', bildaufbau: 'Bildaufbau', kamera: 'Kamera', licht: 'Licht', standort: 'Standort' };

function renderMotifs() {
  const ol = $('#motifs');
  ol.replaceChildren(...state.motifs.map(m => {
    const li = document.createElement('li'); li.className = 'motif panel'; li.id = `motif-${m.nr}`; li.dataset.nr = m.nr;
    li.tabIndex = 0;
    const head = document.createElement('div'); head.className = 'motif-head';
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = m.nr;
    const tw = document.createElement('div');
    const h = document.createElement('h3'); h.className = 'motif-title'; h.textContent = m.titel;
    const src = document.createElement('span'); src.className = 'motif-src';
    src.textContent = state.results.length > 1 ? `Bild ${m.bild} · ${state.results[m.bild - 1].label}` : state.results[0].label;
    tw.append(h, src);
    const thumb = document.createElement('canvas'); thumb.className = 'motif-thumb'; thumb.width = 144; thumb.height = 144;
    drawThumb(thumb, m);
    head.append(badge, tw, thumb);
    const why = document.createElement('p'); why.className = 'motif-why'; why.textContent = m.warum;
    const dl = document.createElement('dl'); dl.className = 'tips';
    for (const k of ['perspektive', 'bildaufbau', 'kamera', 'licht', 'standort']) {
      if (!m[k]) continue;
      const row = document.createElement('div'); row.className = 'tip';
      const dt = document.createElement('dt'); dt.innerHTML = ICONS[k]; dt.setAttribute('aria-label', TIP_LABELS[k]);
      const dd = document.createElement('dd');
      const b = document.createElement('b'); b.textContent = TIP_LABELS[k] + ':';
      dd.append(b, document.createTextNode(m[k]));
      row.append(dt, dd); dl.append(row);
    }
    const practice = document.createElement('div'); practice.className = 'practice'; practice.id = `practice-${m.nr}`;
    practice.addEventListener('click', (e) => e.stopPropagation());
    practice.addEventListener('keydown', (e) => e.stopPropagation());
    li.append(head, why, dl, practice);
    if (isDone(m.nr)) badge.classList.add('done');
    li.addEventListener('click', () => select(m.nr, true));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(m.nr, true); } });
    return li;
  }));
  if (!state.motifs.length) {
    const li = document.createElement('li'); li.className = 'panel';
    li.textContent = 'Die KI hat auf diesen Fotos keine lohnenden Motive gefunden. Probier einen anderen Blickwinkel oder mehr Fotos.';
    ol.append(li);
  }
  state.motifs.forEach(m => renderPractice(m.nr));
}

function drawThumb(t, m) {
  const base = state.results[m.bild - 1].canvas;
  const b = boxPx(m, base);
  const pad = 0.12;
  let w = (b.x1 - b.x0) * (1 + 2 * pad), h = (b.y1 - b.y0) * (1 + 2 * pad);
  const side = Math.min(Math.max(w, h), base.width, base.height);
  // Quadrat möglichst im Bild halten (keine schwarzen Ränder)
  let x = Math.max(0, Math.min(base.width - side, (b.x0 + b.x1) / 2 - side / 2));
  let y = Math.max(0, Math.min(base.height - side, (b.y0 + b.y1) / 2 - side / 2));
  const g = t.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, t.width, t.height);
  g.drawImage(base, x, y, side, side, 0, 0, t.width, t.height);
}

/* ---------- Lernschleife: Motiv fotografieren -> Feedback vom Coach ---------- */
const ATTEMPT_LONG = 1600;   // eigenes Foto: an die KI + gespeichert
const REF_LONG = 1024;       // Motiv-Ausschnitt als Wiedererkennung
const AMPEL_TXT = { gruen: 'grün', gelb: 'gelb', rot: 'rot' };
const CRIT = [['perspektive', 'Perspektive'], ['bildaufbau', 'Bildaufbau'], ['licht', 'Licht']];

const isDone = (nr) => (state.attempts[nr] || []).some(a => a.fb && a.fb.motiv_erkannt);
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

function updateProgress() {
  const el = document.getElementById('practice-progress');
  if (!el) return;
  const n = state.motifs.length, done = state.motifs.filter(m => isDone(m.nr)).length;
  el.hidden = !n;
  el.textContent = done
    ? `📷 Fotografiert: ${done} von ${n} Motiven${done === n ? ' – stark! 🎉' : ''}`
    : '📷 Tipp: Fotografiere ein Motiv und lass dir vom Coach Feedback geben.';
  el.classList.toggle('all', n > 0 && done === n);
}

function abortAttempts() {
  Object.values(state.attempts).flat().forEach(a => { if (a.ctl) a.ctl.abort(); });
}

function fileInput(capture) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
  if (capture) inp.setAttribute('capture', 'environment');
  return inp;
}

function renderPractice(nr) {
  const box = document.getElementById(`practice-${nr}`);
  if (!box) return;
  const list = state.attempts[nr] || [];
  const busy = list.some(a => a.pending);
  const nodes = [];

  // Knöpfe
  const act = document.createElement('div'); act.className = 'practice-actions';
  if (list.length) { const t = document.createElement('span'); t.className = 'practice-label'; t.textContent = 'Nächster Versuch:'; act.append(t); }
  const cam = document.createElement('label'); cam.className = 'glass-btn small' + (busy ? ' disabled' : '');
  const ci = fileInput(true); ci.disabled = busy;
  cam.append(ci, document.createTextNode('📷 Schnell-Foto'));
  cam.title = 'Öffnet die Kamera direkt – je nach Handy ohne Porträtmodus, Zoomstufen und Einstellungen';
  const gal = document.createElement('label'); gal.className = 'glass-btn small' + (busy ? ' disabled' : '');
  const gi = fileInput(false); gi.disabled = busy;
  gal.append(gi, document.createTextNode('🖼 Aus Galerie'));
  for (const inp of [ci, gi]) inp.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) startAttempt(nr, f, { camera: inp === ci });
  });
  act.append(cam, gal);
  nodes.push(act);
  if (!list.length) {
    const tip = document.createElement('p'); tip.className = 'practice-tip';
    tip.textContent = 'Für Porträtmodus, Zoom & Co.: mit der normalen Kamera-App fotografieren, dann „Aus Galerie“ – die neuesten Fotos stehen dort oben.';
    nodes.push(tip);
  }

  if (list.length) {
    // Versuchsstreifen
    if (list.length > 1) {
      const strip = document.createElement('ol'); strip.className = 'attempts';
      list.forEach((a, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'attempt-thumb' + (i === state.view[nr] ? ' active' : '');
        b.setAttribute('aria-label', `Versuch ${i + 1} anzeigen`);
        const img = document.createElement('img'); img.src = a.url; img.alt = '';
        const t = document.createElement('span'); t.textContent = `Versuch ${i + 1}`;
        b.append(img, t);
        b.addEventListener('click', () => { state.view[nr] = i; renderPractice(nr); });
        li.append(b); strip.append(li);
      });
      nodes.push(strip);
    }
    const a = list[state.view[nr] ?? list.length - 1];
    if (a) nodes.push(renderAttempt(nr, a, list.indexOf(a)));
  }
  box.replaceChildren(...nodes);
}

// „Nächster Versuch“: Tipp + direkt wieder zur Kamera (oder aus der Galerie)
function nextAttempt(nr, text) {
  const box = document.createElement('div'); box.className = 'fb-next';
  const cam = document.createElement('label'); cam.className = 'next-btn';
  const ci = fileInput(true);
  const icon = document.createElement('span'); icon.className = 'next-icon'; icon.textContent = '📷'; icon.setAttribute('aria-hidden', 'true');
  const t = document.createElement('span'); t.className = 'next-text';
  const b = document.createElement('b'); b.textContent = 'Nächster Versuch – jetzt fotografieren';
  const p = document.createElement('span'); p.textContent = text;
  t.append(b, p);
  const arrow = document.createElement('span'); arrow.className = 'next-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
  cam.append(ci, icon, t, arrow);
  const gal = document.createElement('label'); gal.className = 'link-btn small next-gal';
  const gi = fileInput(false);
  gal.append(gi, document.createTextNode('oder 🖼 aus der Galerie (Kamera-App mit Zoom & Porträt)'));
  for (const inp of [ci, gi]) inp.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) startAttempt(nr, f, { camera: inp === ci });
  });
  box.append(cam, gal);
  return box;
}

// Speichern/Teilen steht immer am Ende eines Versuchs – dort, wo man nach dem Lesen des Feedbacks ankommt
function renderAttempt(nr, a, idx) {
  const wrap = renderAttemptBody(nr, a, idx);
  wrap.append(saveRow(nr, a, idx));
  return wrap;
}

function renderAttemptBody(nr, a, idx) {
  const wrap = document.createElement('div'); wrap.className = 'feedback';
  const head = document.createElement('div'); head.className = 'fb-head';
  head.textContent = `Versuch ${idx + 1}`;
  wrap.append(head);

  const cv = document.createElement('canvas'); cv.className = 'fb-photo';
  cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', `Dein Foto, Versuch ${idx + 1}`);
  wrap.append(cv);
  drawAttempt(a, cv);

  if (a.chips && a.chips.length) {
    const chips = document.createElement('ul'); chips.className = 'chips';
    chips.setAttribute('aria-label', 'Gemessen');
    for (const c of a.chips) {
      const li = document.createElement('li'); li.className = 'chip' + (c.info ? ' info' : c.ok ? ' ok' : c.bad ? ' bad' : c.warn ? ' warn' : '');
      li.textContent = c.text; chips.append(li);
    }
    wrap.append(chips);
  }

  if (a.pending) {
    const st = document.createElement('p'); st.className = 'fb-status'; st.id = `st-${a.id}`; st.setAttribute('aria-live', 'polite');
    st.textContent = a.status || 'Der Coach schaut sich dein Foto an …';
    wrap.append(progress.bar(a.id), st);
    return wrap;
  }
  if (a.error) {
    const er = document.createElement('div'); er.className = 'fb-error';
    const p = document.createElement('p'); p.textContent = a.error;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'glass-btn small'; b.textContent = 'Nochmal auswerten';
    b.addEventListener('click', () => { if (!hasAi()) { openSetup(() => runJudge(nr, a)); return; } runJudge(nr, a); });
    er.append(p, b); wrap.append(er);
    return wrap;
  }
  const fb = a.fb;
  if (!fb) return wrap;
  const sec = (cls, icon, label, text) => {
    const d = document.createElement('div'); d.className = 'fb-sec ' + cls;
    const i = document.createElement('span'); i.className = 'fb-icon'; i.textContent = icon; i.setAttribute('aria-hidden', 'true');
    const t = document.createElement('div');
    const b = document.createElement('b'); b.textContent = label;
    const p = document.createElement('p'); p.textContent = text;
    t.append(b, p); d.append(i, t);
    return d;
  };
  if (!fb.motiv_erkannt) {
    wrap.append(sec('wrong', '🤔', 'Anderes Motiv?', fb.hinweis || 'Auf diesem Foto erkenne ich das Motiv nicht wieder.'));
    if (fb.naechster_versuch) wrap.append(nextAttempt(nr, fb.naechster_versuch));
    return wrap;
  }
  if (fb.fortschritt && idx > 0) wrap.append(sec('progress', '📈', 'Gegenüber dem letzten Versuch', fb.fortschritt));
  wrap.append(sec('good', '✅', 'Gelungen', fb.gelungen));

  const crit = document.createElement('ul'); crit.className = 'ampel';
  for (const [k, label] of CRIT) {
    const c = fb.kriterien[k];
    const li = document.createElement('li');
    const dot = document.createElement('span'); dot.className = 'dot ' + c.ampel; dot.setAttribute('aria-hidden', 'true');
    const b = document.createElement('b'); b.textContent = label;
    const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = ` (${AMPEL_TXT[c.ampel]})`;
    const t = document.createElement('span'); t.textContent = c.kommentar;
    li.append(dot, b, sr, t); crit.append(li);
  }
  wrap.append(crit);

  if (fb.verbessern.length) {
    const d = document.createElement('div'); d.className = 'fb-sec improve';
    const i = document.createElement('span'); i.className = 'fb-icon'; i.textContent = '🔧'; i.setAttribute('aria-hidden', 'true');
    const t = document.createElement('div');
    const b = document.createElement('b'); b.textContent = 'Verbessern';
    const ul = document.createElement('ol'); ul.className = 'improve-list';
    let letter = 0;
    for (const v of fb.verbessern) {
      const li = document.createElement('li');
      const mk = document.createElement('span');
      if (v.box) { mk.className = 'mk'; mk.textContent = String.fromCharCode(65 + letter++); }
      else { mk.className = 'mk none'; mk.textContent = '•'; mk.setAttribute('aria-hidden', 'true'); }
      li.append(mk);
      li.append(document.createTextNode(v.text));
      ul.append(li);
    }
    t.append(b, ul); d.append(i, t); wrap.append(d);
  }
  if (fb.naechster_versuch) wrap.append(nextAttempt(nr, fb.naechster_versuch));
  if (a.model && a.model !== settings.model) {
    const n = document.createElement('p'); n.className = 'fb-model'; n.textContent = `Ausgewertet mit ${modelName(a.model)}.`;
    wrap.append(n);
  }
  return wrap;
}

// Foto mit den Markierungen A, B, C aus „Verbessern“
async function drawAttempt(a, cv) {
  if (!a.canvas) { try { a.canvas = await decode(a.blob, ATTEMPT_LONG); } catch (_) { return; } }
  const base = a.canvas;
  cv.width = base.width; cv.height = base.height;
  const g = cv.getContext('2d');
  g.drawImage(base, 0, 0);
  const marks = a.fb && a.fb.motiv_erkannt ? a.fb.verbessern.filter(v => v.box) : [];
  const lw = Math.max(3, Math.round(Math.min(base.width, base.height) * 0.008));
  const rad = Math.max(14, Math.round(Math.min(base.width, base.height) * 0.035));
  marks.forEach((v, i) => {
    const x0 = v.box.x0 / 1000 * base.width, x1 = v.box.x1 / 1000 * base.width;
    const y0 = v.box.y0 / 1000 * base.height, y1 = v.box.y1 / 1000 * base.height;
    g.lineJoin = 'round';
    g.setLineDash([lw * 3, lw * 2]);
    g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = lw * 1.9; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = '#3ee6ff'; g.lineWidth = lw; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    g.setLineDash([]);
    const bx = Math.max(rad + 2, Math.min(base.width - rad - 2, x0)), by = Math.max(rad + 2, Math.min(base.height - rad - 2, y0));
    g.beginPath(); g.arc(bx, by, rad + lw * 0.45, 0, Math.PI * 2); g.fillStyle = '#111'; g.fill();
    g.beginPath(); g.arc(bx, by, rad, 0, Math.PI * 2); g.fillStyle = '#3ee6ff'; g.fill();
    g.fillStyle = '#111'; g.font = `700 ${Math.round(rad * 1.1)}px "Martian Mono", ui-monospace, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String.fromCharCode(65 + i), bx, by + rad * 0.06);
  });
}

async function startAttempt(nr, file, { camera = false } = {}) {
  const m = state.motifs.find(x => x.nr === nr);
  if (!m) return;
  let canvas, exif = null;
  try {
    exif = await readExif(file);
    canvas = await decode(file, ATTEMPT_LONG);
  } catch (_) { toast('Dieses Foto kann der Browser nicht öffnen (z. B. HEIC). Bitte als JPG aufnehmen.', 4500); return; }
  const meas = measure(canvas);
  const { chips, facts } = describe(meas, exif);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
  // orig: unveränderte Originaldatei (volle Auflösung, EXIF) – nur sie wird gespeichert/geteilt
  const a = { id: newId(), blob, url: URL.createObjectURL(blob), canvas, chips, facts, pending: true, fb: null, error: '', model: '',
    orig: file, origType: file.type || 'image/jpeg', camera, saved: false, ts: Date.now() };
  (state.attempts[nr] ||= []).push(a);
  state.view[nr] = state.attempts[nr].length - 1;
  renderPractice(nr);
  document.getElementById(`practice-${nr}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!hasAi()) { a.pending = false; a.error = 'Für das Feedback braucht der Coach Zugang zur KI.'; renderPractice(nr); openSetup(() => runJudge(nr, a)); return; }
  runJudge(nr, a);
}

function cropRef(m) {
  const base = state.results[m.bild - 1].canvas;
  const bw = (m.box.x1 - m.box.x0) / 1000 * base.width, bh = (m.box.y1 - m.box.y0) / 1000 * base.height;
  const pw = bw * 0.2, ph = bh * 0.2;
  const x = Math.max(0, m.box.x0 / 1000 * base.width - pw), y = Math.max(0, m.box.y0 / 1000 * base.height - ph);
  const w = Math.min(base.width - x, bw + 2 * pw), h = Math.min(base.height - y, bh + 2 * ph);
  const s = Math.min(1, REF_LONG / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(base, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

async function runJudge(nr, a) {
  const m = state.motifs.find(x => x.nr === nr);
  if (!m) return;
  if (!a.canvas) a.canvas = await decode(a.blob, ATTEMPT_LONG);
  a.pending = true; a.error = ''; a.fb = null;
  a.status = 'Der Coach schaut sich dein Foto an …';
  a.ctl = new AbortController();
  progress.start(a.id);
  renderPractice(nr);
  const list = state.attempts[nr];
  const prev = list.slice(0, list.indexOf(a)).reverse().find(x => x.fb && x.fb.motiv_erkannt);
  const input = {
    ref: canvasToBase64(cropRef(m), REF_LONG),
    photo: canvasToBase64(a.canvas, ATTEMPT_LONG),
    motif: m, facts: a.facts, previous: prev ? prev.fb : null,
  };
  const status = (t) => { a.status = t.replace(/^(Gemini[^ ]* [^ ]+( [^ ]+)?) schaut/, 'Der Coach schaut'); const el = document.getElementById(`st-${a.id}`); if (el) el.textContent = a.status; };
  try {
    const { out, model } = await withFallback(
      (model) => judge(input, { key: settings.key, model, thinking: settings.thinking, signal: a.ctl.signal }),
      status, a.ctl.signal, () => true, 'schaut sich dein Foto an …', { kind: 'judge', prog: a.id });
    a.fb = out; a.model = model;
  } catch (e) {
    progress.stop(a.id);
    if (e && e.name === 'AbortError') return;
    a.error = (e && e.message) || 'Unbekannter Fehler.';
    lastError = `${new Date().toLocaleTimeString('de-DE')} Feedback: ${a.error}${e && e.status ? ` (HTTP ${e.status})` : ''}`;
  } finally {
    a.pending = false; a.ctl = null;
  }
  progress.stop(a.id);
  if (!state.motifs.includes(m)) return;   // inzwischen neue Auswertung
  renderPractice(nr);
  document.querySelector(`#motif-${nr} .badge`)?.classList.toggle('done', isDone(nr));
  updateProgress();
  if (m.bild) drawAnnotated(m.bild - 1);
  persist();
}

/* ---------- Feedback für Tester (-> /api/feedback, Mail über den Kontakt-Dienst) ---------- */
const APP_VERSION = '0.4.10';
let lastError = '';
let fbToken = '';
const fbDlg = $('#feedback');

function techInfo() {
  const n = Object.values(state.attempts).flat().length;
  return [
    `Foto-Coach ${APP_VERSION}`,
    `Browser: ${navigator.userAgent}`,
    `Bildschirm: ${screen.width}×${screen.height} @${window.devicePixelRatio || 1}, Fenster ${innerWidth}×${innerHeight}`,
    `KI: ${settings.model}, Denkzeit ${settings.thinking}, Ausweichen ${settings.fallback ? 'an' : 'aus'}, ${settings.key ? 'eigener Schlüssel' : state.proxy ? 'Server-Schlüssel' : 'kein Schlüssel'}`,
    `Sitzung: ${state.photos.length} Foto(s), ${state.motifs.length} Motiv(e), ${n} Versuch(e)`,
    `Letzter Fehler: ${lastError || '–'}`,
  ].join('\n');
}
const fbSay = (t, cls) => { const el = $('#fb-status'); el.textContent = t; el.className = 'key-status' + (cls ? ' ' + cls : ''); };
async function fbGetToken() {
  try {
    const j = await (await fetch('/api/kontakt/token', { cache: 'no-store' })).json();
    fbToken = j.t || '';   // „active“ betrifft nur den Mailversand des Kontaktformulars – Feedback wird als Datei gespeichert
  } catch (_) { fbToken = ''; }
}
function openFeedback() {
  fbSay('', '');
  $('#fb-tech-preview').hidden = true;
  try { const p = JSON.parse(localStorage.getItem('fotocoach.feedback') || '{}'); if (!$('#fb-name').value) $('#fb-name').value = p.name || ''; if (!$('#fb-email').value) $('#fb-email').value = p.email || ''; } catch (_) {}
  fbGetToken();
  if (typeof fbDlg.showModal === 'function') fbDlg.showModal(); else fbDlg.setAttribute('open', '');
}
$('#btn-feedback').addEventListener('click', openFeedback);
$('#fb-cancel').addEventListener('click', () => fbDlg.close());
$('#fb-tech-show').addEventListener('click', (e) => {
  e.preventDefault();
  const pre = $('#fb-tech-preview'); pre.textContent = techInfo(); pre.hidden = !pre.hidden;
});
$('#feedback-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const message = $('#fb-message').value.trim(), name = $('#fb-name').value.trim(), email = $('#fb-email').value.trim();
  if (message.length < 5) { fbSay('Bitte schreib kurz, worum es geht.', 'bad'); $('#fb-message').focus(); return; }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) { fbSay('Die E-Mail-Adresse sieht nicht gültig aus – oder lass das Feld leer.', 'bad'); $('#fb-email').focus(); return; }
  if (!fbToken) await fbGetToken();
  const btn = $('#fb-send'); btn.disabled = true; fbSay('Wird gesendet …', '');
  try {
    const r = await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app: 'fotocoach', kind: f.kind.value, message, name, email,
        tech: $('#fb-tech').checked ? techInfo() : '', website: f.website.value, t: fbToken,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      try { localStorage.setItem('fotocoach.feedback', JSON.stringify({ name, email })); } catch (_) {}
      $('#fb-message').value = '';
      fbDlg.close();
      toast('✓ Danke! Dein Feedback ist angekommen.');
      fbGetToken();
    } else fbSay(j.error || 'Senden fehlgeschlagen – bitte später erneut.', 'bad');
  } catch (_) {
    fbSay('Keine Verbindung zum Server – bitte später erneut.', 'bad');
  } finally { btn.disabled = false; }
});

/* ---------- Gelungene Fotos sichern ---------- */
// Fotos aus „Jetzt fotografieren“ landen meist NICHT in der Galerie. Gespeichert wird immer die Originaldatei.
const greens = (fb) => fb && fb.motiv_erkannt ? CRIT.filter(([k]) => fb.kriterien[k].ampel === 'gruen').length : 0;

function saveRow(nr, a, idx) {
  const row = document.createElement('div'); row.className = 'save-row';
  if (!a.orig && !a.blob) return row;
  const b = document.createElement('button'); b.type = 'button';
  const star = greens(a.fb) >= 2;
  if (a.saved) {
    b.className = 'glass-btn small saved'; b.textContent = '✓ Gespeichert';
    b.title = 'Nochmal speichern';
  } else {
    b.className = 'glass-btn small' + (star ? ' primary' : '');
    b.textContent = star ? '⭐ Behalten' : '💾 Speichern';
  }
  b.addEventListener('click', () => saveAttempt(nr, a, idx));
  row.append(b);
  if (!IS_IOS && navigator.canShare && navigator.share) {
    const sh = document.createElement('button'); sh.type = 'button'; sh.className = 'glass-btn small'; sh.textContent = '↗ Teilen';
    sh.addEventListener('click', () => shareAttempt(nr, a, idx));
    row.append(sh);
  }
  const hint = document.createElement('span'); hint.className = 'save-hint';
  hint.textContent = a.saved ? 'Originalfoto gesichert' : a.camera ? 'Noch nicht in deiner Galerie' : 'Liegt schon in deiner Galerie';
  row.append(hint);
  return row;
}

function attemptFileName(nr, a, idx) {
  const m = state.motifs.find(x => x.nr === nr);
  const slug = ((m && m.titel) || 'motiv').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'motiv';
  const d = new Date(a.ts || Date.now());
  const p2 = (v) => String(v).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const ext = /png/.test(a.origType) ? 'png' : /webp/.test(a.origType) ? 'webp' : /hei[cf]/.test(a.origType) ? 'heic' : 'jpg';
  return `fotocoach-${stamp}-${slug}-v${idx + 1}.${ext}`;
}

// iPhone/iPad: In die Fotos-App kommt man nur über das Teilen-Menü („Bild sichern“).
// Android & PC: direkter Download – landet im Ordner „Download“, den Galerie-Apps als Album zeigen.
// (Das Teilen-Menü bietet auf vielen Android-Handys, z. B. Xiaomi, gar kein „Auf Gerät speichern“ an.)
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const SAVED_HINT = IS_IOS ? '✓ In „Fotos“ gesichert' : '✓ Gespeichert im Ordner „Download“ – in der Galerie unter Alben › Download';

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function shareFiles(files) {
  if (!(navigator.canShare && navigator.share && navigator.canShare({ files }))) return 'unsupported';
  try { await navigator.share({ files }); return 'ok'; }
  catch (e) { return e && e.name === 'AbortError' ? 'abort' : 'unsupported'; }
}

// Original (volle Auflösung) – bei Versuchen aus alten Sitzungen ohne Original die gespeicherte 1600-px-Fassung
function attemptFile(nr, a, idx) {
  if (a.orig) return new File([a.orig], attemptFileName(nr, a, idx), { type: a.origType || 'image/jpeg' });
  return new File([a.blob], attemptFileName(nr, { ...a, origType: 'image/jpeg' }, idx), { type: 'image/jpeg' });
}

async function saveAttempt(nr, a, idx) {
  const file = attemptFile(nr, a, idx);
  if (IS_IOS) {
    const r = await shareFiles([file]);
    if (r === 'abort') return;
    if (r === 'unsupported') downloadBlob(file, file.name);
  } else {
    downloadBlob(file, file.name);
  }
  a.saved = true;
  toast(SAVED_HINT, 5000);
  renderPractice(nr);
  persist();
}

async function shareAttempt(nr, a, idx) {
  const file = attemptFile(nr, a, idx);
  const r = await shareFiles([file]);
  if (r === 'unsupported') toast('Teilen wird von diesem Browser nicht unterstützt – nutze „Speichern“.');
}

/* ---------- Sicherung + Fortsetzen ---------- */
let persistTimer = 0;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    if (!state.motifs.length || !state.results.length) return;
    for (const r of state.results) {
      if (!r.blob) r.blob = await new Promise(res => r.canvas.toBlob(res, 'image/jpeg', 0.9));
    }
    const attempts = {};
    for (const [nr, list] of Object.entries(state.attempts)) {
      attempts[nr] = list.map(a => ({ id: a.id, blob: a.blob, chips: a.chips, facts: a.facts, fb: a.fb, error: a.pending ? 'Unterbrochen – bitte nochmal auswerten.' : a.error, model: a.model,
        orig: a.orig, origType: a.origType, camera: a.camera, saved: a.saved, ts: a.ts }));
    }
    await saveSession({
      gesamteindruck: state.gesamteindruck, notes: state.resultNotes, motifs: state.motifs,
      results: state.results.map(r => ({ blob: r.blob, label: r.label, indices: r.indices, wide: r.wide })),
      attempts,
    });
  }, 300);
}

let resumeData = null;
async function checkResume() {
  resumeData = await loadSession();
  const b = $('#resume-banner');
  if (!resumeData) { b.hidden = true; return; }
  const n = resumeData.motifs.length;
  const done = resumeData.motifs.filter(m => (resumeData.attempts[m.nr] || []).some(a => a.fb && a.fb.motiv_erkannt)).length;
  const min = Math.round((Date.now() - resumeData.ts) / 60000);
  const when = min < 2 ? 'gerade eben' : min < 60 ? `vor ${min} Min.` : min < 1440 ? `vor ${Math.round(min / 60)} Std.` : `vor ${Math.round(min / 1440)} Tagen`;
  $('#resume-text').textContent = `Letzte Auswertung fortsetzen – ${when}, ${done} von ${n} Motiven fotografiert`;
  b.hidden = false;
}

async function restoreSession() {
  const d = resumeData;
  if (!d) return;
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = []; renderThumbs(); state.prepared = null;
  state.results = [];
  for (const r of d.results) state.results.push({ canvas: await decode(r.blob, 8192), blob: r.blob, label: r.label, indices: r.indices, wide: r.wide });
  abortAttempts();
  state.attempts = {}; state.view = {};
  for (const [nr, list] of Object.entries(d.attempts || {})) {
    state.attempts[nr] = list.map(a => ({ ...a, url: URL.createObjectURL(a.blob), canvas: null, pending: false }));
    state.view[nr] = state.attempts[nr].length - 1;
  }
  renderResult({ gesamteindruck: d.gesamteindruck, motive: d.motifs }, d.notes || [], { fresh: false });
}
$('#resume-banner').addEventListener('click', restoreSession);

/* ---------- Speichern / Teilen ---------- */
async function exportBlobs() {
  const out = [];
  const keep = state.selected; state.selected = 0;
  for (let i = 0; i < state.results.length; i++) {
    const c = document.createElement('canvas');
    drawAnnotated(i, c);
    out.push(await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)));
  }
  state.selected = keep;
  return out;
}
async function saveImages() {
  const blobs = await exportBlobs();
  const d = new Date(), p2 = (v) => String(v).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  blobs.forEach((b, i) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `fotocoach-${stamp}${blobs.length > 1 ? '-' + (i + 1) : ''}.jpg`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  toast(IS_IOS ? '✓ Gespeichert unter „Dateien“ › Downloads – für die Fotos-App „Teilen“ › „Bild sichern“ nutzen' : SAVED_HINT, 5000);
}
async function shareImages() {
  const blobs = await exportBlobs();
  const files = blobs.map((b, i) => new File([b], `fotocoach-${i + 1}.jpg`, { type: 'image/jpeg' }));
  const text = state.motifs.map(m => `${m.nr}. ${m.titel} – ${m.warum}`).join('\n');
  const data = { files, title: 'Foto-Coach', text };
  try {
    if (navigator.canShare && navigator.canShare({ files })) await navigator.share(data);
    else await navigator.share({ title: 'Foto-Coach', text });
  } catch (_) { /* abgebrochen */ }
}

function unsavedCount() {
  return Object.values(state.attempts).flat().filter(a => a.camera && !a.saved && a.orig).length;
}
function restart() {
  const n = unsavedCount();
  if (n) {
    $('#unsaved-text').textContent = n === 1
      ? 'Ein Foto aus der Kamera ist noch nicht gespeichert. Es landet nicht automatisch in deiner Galerie und geht beim Neustart verloren.'
      : `${n} Fotos aus der Kamera sind noch nicht gespeichert. Sie landen nicht automatisch in deiner Galerie und gehen beim Neustart verloren.`;
    const d = $('#unsaved');
    d.returnValue = '';
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    return;
  }
  doRestart();
}
$('#unsaved').addEventListener('close', () => { if ($('#unsaved').returnValue === 'go') doRestart(); });
function doRestart() {
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  abortAttempts();
  state.photos = []; state.lastBitmap = null; state.results = []; state.motifs = []; state.prepared = null;
  state.attempts = {}; state.view = {};
  checkResume();
  renderThumbs();
  show('screen-capture');
}

/* ---------- Einstellungen ---------- */
const dlg = $('#settings');
function openSettings() {
  settings = store.get();
  $('#set-key').value = settings.key; $('#set-key').type = 'password';
  $('#qr-box').hidden = true; setKeyStatus('#set-key-status', '', '');
  $('#set-model').value = settings.model;
  if ($('#set-model').value !== settings.model) { const o = new Option(settings.model, settings.model); $('#set-model').add(o); $('#set-model').value = settings.model; }
  $('#set-count').value = settings.count; $('#set-count-val').textContent = settings.count;
  $('#set-ghost').checked = settings.ghost;
  $('#set-fallback').checked = settings.fallback;
  $('#set-thinking').value = settings.thinking || 'low';
  $('#key-undo').hidden = true; updateKeyMode();
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  settings = {
    key: $('#set-key').value.trim(),
    model: $('#set-model').value,
    count: Number($('#set-count').value) || 5,
    ghost: $('#set-ghost').checked,
    fallback: $('#set-fallback').checked,
    thinking: $('#set-thinking').value,
    sv: 2,
  };
  store.set(settings);
  drawGhost();
  updateBanner();
});
$('#set-count').addEventListener('input', (e) => { $('#set-count-val').textContent = e.target.value; });
$('#btn-key-toggle').addEventListener('click', () => { const k = $('#set-key'); k.type = k.type === 'password' ? 'text' : 'password'; });

/* ---------- Ereignisse ---------- */
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-error-settings').addEventListener('click', () => { if (!hasAi()) openSetup(() => runPipeline({ reuse: true })); else openSettings(); });
$('#btn-shutter').addEventListener('click', capture);
$('#btn-next').addEventListener('click', () => {
  if (!state.photos.length) return;
  if (!hasAi()) { openSetup(() => runPipeline()); return; }
  runPipeline();
});
$('#btn-cancel').addEventListener('click', cancelRun);
$('#btn-retry').addEventListener('click', () => runPipeline({ reuse: true }));
$('#btn-restart').addEventListener('click', restart);
$('#btn-save').addEventListener('click', saveImages);
$('#btn-share').addEventListener('click', shareImages);
for (const id of ['#file-gallery', '#file-camera', '#file-camera-main']) {
  $(id).addEventListener('change', async (e) => {
    const files = [...e.target.files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|heic|webp)$/i.test(f.name));
    for (const f of files) await addPhoto(f);
    e.target.value = '';
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if ($('#screen-capture').classList.contains('active')) startCamera();
});

/* ---------- Schlüssel: Einrichtung, Prüfung, QR-Übergabe ---------- */
const hasAi = () => !!settings.key || state.proxy;
function updateBanner() { $('#setup-banner').hidden = hasAi(); }
function setKeyStatus(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'key-status' + (cls ? ' ' + cls : ''); }
function toast(text, ms = 3200) {
  const t = $('#toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const KEY_MSG = {
  ok: ['✓ Schlüssel funktioniert.', 'ok'],
  invalid: ['✗ Google kennt diesen Schlüssel nicht. Bitte nochmal kopieren.', 'bad'],
  denied: ['✗ Schlüssel gesperrt oder Gemini-API im Projekt nicht aktiv.', 'bad'],
  offline: ['Keine Verbindung zu Google – Schlüssel wird trotzdem gespeichert.', ''],
};
let checkCtl = null;
async function checkKey(raw, statusSel) {
  const key = cleanKey(raw);
  if (!key) { setKeyStatus(statusSel, '', ''); return null; }
  if (!looksLikeKey(key)) { setKeyStatus(statusSel, 'Das sieht nicht wie ein Gemini-Schlüssel aus (beginnt meist mit „AQ.“ oder „AIza“).', 'bad'); return null; }
  setKeyStatus(statusSel, 'Prüfe bei Google …', '');
  if (checkCtl) checkCtl.abort();
  checkCtl = new AbortController();
  try {
    const r = await testKey(key, checkCtl.signal);
    setKeyStatus(statusSel, ...KEY_MSG[r]);
    return (r === 'ok' || r === 'offline') ? key : null;
  } catch (_) { return null; }
}

// Einrichtungs-Dialog
const setupDlg = $('#setup');
let afterSetup = null;
function openSetup(then) {
  afterSetup = then || null;
  $('#setup-key').value = '';
  $('#setup-done').disabled = true;
  setKeyStatus('#setup-status', 'Wird nach dem Einfügen automatisch geprüft.', '');
  if (typeof setupDlg.showModal === 'function') setupDlg.showModal(); else setupDlg.setAttribute('open', '');
}
async function setupTry(raw) {
  const key = await checkKey(raw, '#setup-status');
  if (!key) { $('#setup-done').disabled = true; return; }
  $('#setup-key').value = key;
  settings = { ...store.get(), key };
  store.set(settings);
  updateBanner();
  $('#setup-done').disabled = false;
  $('#setup-done').focus();
}
$('#setup-paste').addEventListener('click', async () => {
  const t = await readClipboard();
  if (t) { $('#setup-key').value = t; setupTry(t); }
  else { $('#setup-key').focus(); setKeyStatus('#setup-status', 'Einfügen wurde nicht erlaubt – lange ins Feld tippen und „Einfügen“ wählen.', ''); }
});
let setupTimer = 0;
$('#setup-key').addEventListener('input', (e) => { clearTimeout(setupTimer); const v = e.target.value; setupTimer = setTimeout(() => setupTry(v), 350); });
$('#setup-banner').addEventListener('click', () => openSetup());
setupDlg.addEventListener('close', () => {
  const go = setupDlg.returnValue === 'done' && hasAi() && afterSetup;
  const fn = afterSetup; afterSetup = null;
  if (go) fn();
});

// Werkzeuge in den Einstellungen
$('#btn-key-paste').addEventListener('click', async () => {
  const t = await readClipboard();
  if (t) { $('#set-key').value = cleanKey(t); updateKeyMode(); checkKey(t, '#set-key-status'); }
  else { $('#set-key').focus(); setKeyStatus('#set-key-status', 'Einfügen wurde nicht erlaubt – lange ins Feld tippen und „Einfügen“ wählen.', ''); }
});
$('#btn-key-test').addEventListener('click', () => checkKey($('#set-key').value, '#set-key-status'));

// Statuszeile: Was wird gerade benutzt? (richtet sich nach dem Feld, nicht erst nach dem Speichern)
function updateKeyMode() {
  const key = cleanKey($('#set-key').value);
  const el = $('#key-mode');
  if (key) { el.textContent = `🔑 Eigener Schlüssel (…${key.slice(-4)})`; el.className = 'key-mode own'; }
  else if (state.proxy) { el.textContent = '🟢 Server-Schlüssel aktiv – kein eigener nötig'; el.className = 'key-mode ok'; }
  else { el.textContent = '🟡 Kein Schlüssel – bitte einrichten'; el.className = 'key-mode warn'; }
  $('#btn-key-clear').disabled = !$('#set-key').value;
}
$('#set-key').addEventListener('input', () => { $('#key-undo').hidden = true; updateKeyMode(); });

// Löschen: sofort gespeichert, 5 s lang rückgängig zu machen
let undoKey = '', undoTimer = 0;
$('#btn-key-clear').addEventListener('click', () => {
  undoKey = store.get().key || cleanKey($('#set-key').value);
  $('#set-key').value = '';
  settings = { ...store.get(), key: '' };
  store.set(settings);
  $('#qr-box').hidden = true;
  setKeyStatus('#set-key-status', '', '');
  updateKeyMode(); updateBanner();
  $('#key-undo').hidden = !undoKey;
  clearTimeout(undoTimer); undoTimer = setTimeout(() => { $('#key-undo').hidden = true; undoKey = ''; }, 5000);
});
$('#btn-key-undo').addEventListener('click', () => {
  if (!undoKey) return;
  $('#set-key').value = undoKey;
  settings = { ...store.get(), key: undoKey };
  store.set(settings);
  undoKey = ''; $('#key-undo').hidden = true;
  updateKeyMode(); updateBanner();
});
$('#btn-key-qr').addEventListener('click', () => {
  const key = cleanKey($('#set-key').value);
  const box = $('#qr-box');
  if (!box.hidden) { box.hidden = true; return; }
  if (!looksLikeKey(key)) { setKeyStatus('#set-key-status', 'Erst einen gültigen Schlüssel eintragen.', 'bad'); return; }
  const svg = qrSvg(handoverUrl(key));
  if (!svg) { setKeyStatus('#set-key-status', 'QR-Code konnte nicht erzeugt werden.', 'bad'); return; }
  $('#qr').innerHTML = svg;
  box.hidden = false;
});

// Start: Schlüssel aus QR-Link übernehmen, Proxy suchen
(function initKeys() {
  const fromHash = takeKeyFromHash();
  if (fromHash) {
    settings = { ...store.get(), key: fromHash };
    store.set(settings);
    toast('✓ Schlüssel übernommen – du kannst loslegen.');
  }
  updateBanner();
  probeProxy().then(ok => { state.proxy = ok; updateBanner(); updateKeyMode(); });
})();

/* ---------- Willkommen (erster Aufruf) ---------- */
const introDlg = $('#intro');
const INTRO_KEY = 'fotocoach.intro';
function showIntro() {
  const desktop = !matchMedia('(pointer: coarse)').matches;
  $('#intro-desktop').hidden = !desktop;
  if (desktop) {
    const svg = qrSvg(location.origin + location.pathname);
    if (svg) $('#intro-qr').innerHTML = svg; else $('#intro-desktop').hidden = true;
  }
  if (typeof introDlg.showModal === 'function') introDlg.showModal(); else introDlg.setAttribute('open', '');
}
introDlg.addEventListener('close', () => {
  try { localStorage.setItem(INTRO_KEY, '1'); } catch (_) {}
  if ($('#screen-capture').classList.contains('active')) startCamera();   // Kamera-Abfrage erst nach der Einführung
});
$('#btn-show-intro').addEventListener('click', () => { dlg.close(); stopCamera(); showIntro(); });

renderThumbs();
let introSeen = false;
try { introSeen = localStorage.getItem(INTRO_KEY) === '1'; } catch (_) { introSeen = true; }
if (introSeen) startCamera(); else showIntro();
checkResume();
