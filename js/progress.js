// Foto-Coach – geschätzter Fortschrittsbalken für KI-Aufrufe.
// Gemini meldet keinen Fortschritt. Der Balken läuft deshalb nach der Dauer, die dieses Modell
// auf diesem Gerät zuletzt gebraucht hat (gleitender Mittelwert), und bleibt bei 95 % stehen,
// bis die Antwort da ist. Je öfter man die App nutzt, desto genauer wird er.

const KEY = 'fotocoach.durations';
const DEFAULT = { analyze: 25, judge: 15 };   // Sekunden, bis eigene Messwerte vorliegen
const CAP = 0.95;

function loadAvg() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return {}; } }
function saveAvg(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) {} }

const runs = new Map();   // id -> { t0, expected, floor, value, finished }
let timer = 0;

function expectedFor(kind, model, thinking) {
  const v = loadAvg()[`${kind}|${model}|${thinking}`];
  return v || DEFAULT[kind] || 20;
}

function valueOf(r, now) {
  if (r.finished) return 1;
  if (!r.expected) return r.floor;
  // ~85 % nach der erwarteten Dauer, danach immer langsamer Richtung 95 %
  const tau = r.expected / 2.25;
  const t = (now - r.t0) / 1000;
  return r.floor + (CAP - r.floor) * (1 - Math.exp(-t / tau));
}

function label(r, now) {
  if (r.finished) return 'Fertig';
  if (!r.expected) return '';
  const left = Math.round(r.expected - (now - r.t0) / 1000);
  if (left > 1) return `noch etwa ${left} s`;
  return 'gleich fertig … (dauert heute etwas länger)';
}

function paint() {
  const now = performance.now();
  for (const el of document.querySelectorAll('.fprog[data-prog]')) {
    const r = runs.get(el.dataset.prog);
    if (!r) { el.hidden = true; continue; }
    const v = Math.max(r.value || 0, valueOf(r, now));
    r.value = v;
    el.hidden = false;
    el.querySelector('.fprog-fill').style.transform = `scaleX(${v.toFixed(4)})`;
    el.querySelector('.fprog-label').textContent = label(r, now);
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }
  if (![...runs.values()].some(r => !r.finished)) { clearInterval(timer); timer = 0; }
}

function tick() { if (!timer) timer = setInterval(paint, 200); paint(); }

export const progress = {
  /** Balken starten (noch ohne Modell: steht kurz bei 2 %) */
  start(id) { runs.set(id, { t0: performance.now(), expected: 0, floor: 0.02, value: 0.02, finished: false }); tick(); },

  /** Neues Modell (auch beim Ausweichen): Schätzung neu, Balken läuft vom aktuellen Stand weiter */
  model(id, kind, model, thinking) {
    const r = runs.get(id);
    if (!r || r.finished) return;
    r.floor = Math.max(r.floor, r.value || 0);
    r.t0 = performance.now();
    r.expected = expectedFor(kind, model, thinking);
    tick();
  },

  /** Erfolgreichen Aufruf merken – gleitender Mittelwert pro Art, Modell und Denkstufe */
  record(kind, model, thinking, sec) {
    if (!(sec > 0.3 && sec < 600)) return;
    const all = loadAvg(), k = `${kind}|${model}|${thinking}`;
    all[k] = all[k] ? Math.round((all[k] * 0.6 + sec * 0.4) * 10) / 10 : Math.round(sec * 10) / 10;
    saveAvg(all);
  },

  done(id) { const r = runs.get(id); if (r) { r.finished = true; paint(); setTimeout(() => { if (runs.get(id) === r) runs.delete(id); paint(); }, 600); } },
  stop(id) { runs.delete(id); paint(); },

  /** Balken-Element für dynamisch erzeugte Bereiche (Feedback-Karten) */
  bar(id) {
    const el = document.createElement('div');
    el.className = 'fprog'; el.dataset.prog = id; el.hidden = true;
    el.setAttribute('role', 'progressbar'); el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
    el.innerHTML = '<div class="fprog-track"><div class="fprog-fill"></div></div><span class="fprog-label"></span>';
    queueMicrotask(paint);
    return el;
  },
};
