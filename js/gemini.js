// Foto-Coach – Anbindung an Google Gemini (generateContent mit JSON-Schema)

const API_DIRECT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const API_PROXY = 'api/gemini/v1beta/models/'; // relativ: Caddy-Proxy auf dem eigenen Server

const SYSTEM = `Du bist ein erfahrener Fotograf und geduldiger Foto-Coach für Hobbyfotografen, die mit dem Smartphone fotografieren.
Du bekommst Übersichtsfotos (teils als Panorama zusammengesetzt) von einem Ort. Deine Aufgabe: die lohnendsten Fotomotive an diesem Ort finden und erklären, wie man sie gut fotografiert.
Regeln:
- Antworte ausschließlich auf Deutsch, duze den Nutzer, sei konkret und praxisnah, keine Floskeln.
- Wähle nur Motive, die auf den Bildern wirklich zu sehen sind. Nichts erfinden.
- Jedes Motiv nur einmal nennen, auch wenn es auf mehreren Bildern zu sehen ist – nimm das Bild, auf dem es am besten zu sehen ist.
- Bevorzuge Motive mit Kontrast, Farbe, Struktur, Licht oder einer kleinen Geschichte. Unterschiedliche Motivarten mischen (Detail, Stillleben, Szene).
- Keine Personen, Autokennzeichen oder Hausnummern als Motiv wählen.
- box_2d umschließt das Motiv eng: [ymin, xmin, ymax, xmax], normiert auf 0–1000 relativ zu dem jeweiligen Bild.
- Tipps sind kurz (je 1–2 Sätze) und auf Smartphone-Kameras zugeschnitten (z. B. Porträtmodus, auf Motiv tippen zum Fokussieren, Belichtung per Wischen anpassen, 2x-Zoom statt Digitalzoom, in die Hocke gehen).
- Licht: beziehe dich auf das Licht, das auf dem Foto zu sehen ist (Sonnenstand, Gegenlicht, Schatten), und sag, ob jetzt oder zu einer anderen Tageszeit besser.
- standort: beschreibe, wo man sich hinstellen soll, relativ zur Aufnahmeposition (z. B. „drei Schritte nach vorn, leicht links").`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    gesamteindruck: { type: 'STRING', description: 'Ein bis zwei Sätze zum Ort und seinem fotografischen Potenzial.' },
    motive: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          bild: { type: 'INTEGER', description: 'Nummer des Bildes (1-basiert), auf dem das Motiv markiert wird.' },
          titel: { type: 'STRING', description: 'Kurzer Name des Motivs, max. 5 Wörter.' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[ymin, xmin, ymax, xmax] 0–1000' },
          warum: { type: 'STRING', description: 'Warum das ein gutes Motiv ist (1 Satz).' },
          perspektive: { type: 'STRING' },
          bildaufbau: { type: 'STRING' },
          kamera: { type: 'STRING' },
          licht: { type: 'STRING' },
          standort: { type: 'STRING' },
        },
        required: ['bild', 'titel', 'box_2d', 'warum', 'perspektive', 'bildaufbau', 'kamera', 'licht', 'standort'],
        propertyOrdering: ['bild', 'titel', 'box_2d', 'warum', 'perspektive', 'bildaufbau', 'kamera', 'licht', 'standort'],
      },
    },
  },
  required: ['gesamteindruck', 'motive'],
  propertyOrdering: ['gesamteindruck', 'motive'],
};

export class GeminiError extends Error {
  constructor(message, { status = 0, retry = true, settings = false } = {}) {
    super(message); this.status = status; this.retry = retry; this.settings = settings;
  }
}

/**
 * @param {Array<{base64:string, label:string}>} images
 * @param {{key?:string, model:string, count:number, signal?:AbortSignal}} opt
 */
export async function analyze(images, opt) {
  const parts = [];
  images.forEach((img, i) => {
    parts.push({ text: `Bild ${i + 1}: ${img.label}` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: img.base64 } });
  });
  parts.push({
    text: `Finde die ${opt.count} besten Fotomotive auf ${images.length > 1 ? 'diesen Bildern' : 'diesem Bild'} (weniger, wenn es nicht so viele lohnende gibt). ` +
      `Sortiere nach Qualität, das stärkste Motiv zuerst.`,
  });
  const parsed = await callGemini(parts, SYSTEM, SCHEMA, 0.4, opt);
  if (!parsed || !Array.isArray(parsed.motive)) {
    throw new GeminiError('Die Antwort der KI war unvollständig. Bitte nochmal versuchen.', { retry: true });
  }
  return normalize(parsed, images.length);
}

/* ---------- Lernschleife: eigenes Foto gegen den Tipp bewerten ---------- */
const JUDGE_SYSTEM = `Du bist ein freundlicher, erfahrener Fotokurs-Lehrer. Ein Hobbyfotograf hat mit dem Smartphone ein Motiv fotografiert, das du ihm vorher empfohlen hast, und möchte wissen, was gelungen ist und was er beim nächsten Mal besser machen kann.
Du bekommst:
- REFERENZ: Ausschnitt aus dem Übersichtsfoto, auf dem du das Motiv empfohlen hast (nur zur Wiedererkennung – das neue Foto soll ausdrücklich anders aussehen: näher, anderer Standpunkt, besserer Ausschnitt).
- DEINE TIPPS von damals.
- FOTO: das neue Foto des Nutzers.
- MESSWERTE: von der App maschinell gemessen (Schärfe, Belichtung, Kameradaten). Das sind Fakten. Behaupte keine Unschärfe, Über- oder Unterbelichtung, die den Messwerten widerspricht und im Bild nicht eindeutig zu sehen ist.
- evtl. FEEDBACK ZUM LETZTEN VERSUCH.
Regeln:
- Deutsch, duzen, Ton eines guten Fotokurs-Lehrers: ehrlich, konkret, ermutigend. Immer zuerst, was gelungen ist – aber nur echtes Lob, nichts erfinden.
- Keine Punktzahlen oder Noten.
- Prüfe zuerst, ob das FOTO dasselbe Motiv zeigt wie die REFERENZ. Anderer Blickwinkel, Ausschnitt oder Abstand ist gewollt und kein Grund für "nein". Nur wenn klar etwas anderes fotografiert wurde: motiv_erkannt = false und in hinweis freundlich sagen, was du stattdessen siehst. Dann die übrigen Felder kurz halten.
- kriterien: für perspektive, bildaufbau und licht je eine Ampel. gruen = Tipp umgesetzt (oder bewusst anders gelöst und trotzdem gut – dann sag das), gelb = teilweise, rot = nicht umgesetzt.
- verbessern: höchstens 3 Punkte, jeder mit einer konkreten Handlung (z. B. "zwei Schritte nach links", "auf das Moos tippen zum Fokussieren", "2x-Zoom statt Digitalzoom"). Wenn sich der Punkt auf eine Stelle im FOTO bezieht, box_2d = [ymin, xmin, ymax, xmax] 0–1000 relativ zum FOTO, sonst weglassen. Ist nichts zu verbessern, leere Liste.
- naechster_versuch: genau ein Satz, die wichtigste Änderung.
- fortschritt: nur wenn es einen letzten Versuch gibt – ein Satz, was sich gegenüber dem letzten Versuch verbessert oder verschlechtert hat.`;

const AMPEL = { type: 'OBJECT', properties: {
  ampel: { type: 'STRING', enum: ['gruen', 'gelb', 'rot'] },
  kommentar: { type: 'STRING', description: 'Ein kurzer Satz.' },
}, required: ['ampel', 'kommentar'], propertyOrdering: ['ampel', 'kommentar'] };

const JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    motiv_erkannt: { type: 'BOOLEAN' },
    hinweis: { type: 'STRING', description: 'Nur wenn motiv_erkannt false: was stattdessen zu sehen ist.' },
    gelungen: { type: 'STRING', description: 'Ein bis zwei Sätze: was am Foto gut ist.' },
    kriterien: { type: 'OBJECT', properties: { perspektive: AMPEL, bildaufbau: AMPEL, licht: AMPEL },
      required: ['perspektive', 'bildaufbau', 'licht'], propertyOrdering: ['perspektive', 'bildaufbau', 'licht'] },
    verbessern: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      text: { type: 'STRING' },
      box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
    }, required: ['text'], propertyOrdering: ['text', 'box_2d'] } },
    naechster_versuch: { type: 'STRING' },
    fortschritt: { type: 'STRING' },
  },
  required: ['motiv_erkannt', 'gelungen', 'kriterien', 'verbessern', 'naechster_versuch'],
  propertyOrdering: ['motiv_erkannt', 'hinweis', 'gelungen', 'kriterien', 'verbessern', 'naechster_versuch', 'fortschritt'],
};

/**
 * @param {{ref:string, photo:string, motif:object, facts:string, previous?:object}} input  (Bilder als base64-JPEG)
 * @param {{key?:string, model:string, signal?:AbortSignal}} opt
 */
export async function judge(input, opt) {
  const m = input.motif;
  const tips = ['perspektive', 'bildaufbau', 'kamera', 'licht', 'standort']
    .filter(k => m[k]).map(k => `- ${k}: ${m[k]}`).join('\n');
  const parts = [
    { text: 'REFERENZ (Ausschnitt aus dem Übersichtsfoto):' },
    { inline_data: { mime_type: 'image/jpeg', data: input.ref } },
    { text: `DEINE TIPPS zum Motiv „${m.titel}“ (${m.warum}):\n${tips}` },
    { text: 'FOTO (neuer Versuch des Nutzers):' },
    { inline_data: { mime_type: 'image/jpeg', data: input.photo } },
    { text: `MESSWERTE:\n${input.facts}` },
  ];
  if (input.previous) {
    const p = input.previous;
    parts.push({ text: `FEEDBACK ZUM LETZTEN VERSUCH: Gelungen: ${p.gelungen} Verbessern: ${(p.verbessern || []).map(v => v.text).join(' / ') || '–'} Nächster Versuch: ${p.naechster_versuch}` });
  }
  parts.push({ text: 'Gib jetzt dein Feedback.' });
  const r = await callGemini(parts, JUDGE_SYSTEM, JUDGE_SCHEMA, 0.3, opt);
  if (!r || typeof r.motiv_erkannt !== 'boolean' || !r.kriterien) {
    throw new GeminiError('Die Antwort der KI war unvollständig. Bitte nochmal versuchen.', { retry: true });
  }
  return normalizeJudge(r);
}

function normalizeJudge(r) {
  const clamp = v => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)));
  const verbessern = (Array.isArray(r.verbessern) ? r.verbessern : []).slice(0, 3).filter(v => v && v.text).map(v => {
    let box = null;
    if (Array.isArray(v.box_2d) && v.box_2d.length === 4) {
      let [y0, x0, y1, x1] = v.box_2d.map(clamp);
      if (y1 < y0) [y0, y1] = [y1, y0];
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 - y0 >= 5 && x1 - x0 >= 5) box = { y0, x0, y1, x1 };
    }
    return { text: String(v.text), box };
  });
  const ampel = (a) => ({ ampel: ['gruen', 'gelb', 'rot'].includes(a && a.ampel) ? a.ampel : 'gelb', kommentar: String((a && a.kommentar) || '') });
  return {
    motiv_erkannt: r.motiv_erkannt,
    hinweis: String(r.hinweis || ''),
    gelungen: String(r.gelungen || ''),
    kriterien: { perspektive: ampel(r.kriterien.perspektive), bildaufbau: ampel(r.kriterien.bildaufbau), licht: ampel(r.kriterien.licht) },
    verbessern,
    naechster_versuch: String(r.naechster_versuch || ''),
    fortschritt: String(r.fortschritt || ''),
  };
}

/* ---------- gemeinsamer Aufruf ---------- */
const noThinkingCfg = new Set();
async function callGemini(parts, system, schema, temperature, opt) {
  const useProxy = !opt.key;
  const url = (useProxy ? API_PROXY : API_DIRECT) + encodeURIComponent(opt.model) + ':generateContent';
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature },
  };
  // Denkzeit: Gemini 3.x Flash denkt ohne Vorgabe auf „medium“ – „low“ ist deutlich schneller.
  if (opt.thinking && !noThinkingCfg.has(opt.model)) body.generationConfig.thinkingConfig = { thinkingLevel: opt.thinking };
  const headers = { 'Content-Type': 'application/json' };
  if (!useProxy) headers['x-goog-api-key'] = opt.key;

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opt.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new GeminiError('Keine Verbindung zu Gemini. Prüfe deine Internetverbindung.', { retry: true });
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (_) {}
    // Modell kennt die Denkstufe nicht -> einmal ohne Vorgabe wiederholen und für die Sitzung merken
    if (res.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(detail)) {
      noThinkingCfg.add(opt.model);
      return callGemini(parts, system, schema, temperature, opt);
    }
    throw mapError(res.status, detail, useProxy, opt.model);
  }
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  if (!cand) {
    const reason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new GeminiError(reason ? `Gemini hat die Bilder abgelehnt (${reason}).` : 'Gemini hat keine Antwort geliefert.', { retry: true });
  }
  const text = ((cand.content && cand.content.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  return parseJson(text);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (_) {} }
  return null;
}

function normalize(r, nImages) {
  const clamp = v => Math.max(0, Math.min(1000, Math.round(Number(v) || 0)));
  const motive = [];
  for (const m of r.motive) {
    if (!m || !Array.isArray(m.box_2d) || m.box_2d.length !== 4) continue;
    let [y0, x0, y1, x1] = m.box_2d.map(clamp);
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 - y0 < 5 || x1 - x0 < 5) continue;
    const bild = Math.min(nImages, Math.max(1, Math.round(Number(m.bild) || 1)));
    motive.push({ ...m, bild, box: { y0, x0, y1, x1 } });
  }
  motive.forEach((m, i) => { m.nr = i + 1; });
  return { gesamteindruck: String(r.gesamteindruck || ''), motive };
}

function mapError(status, detail, useProxy, model) {
  const d = (detail || '').toLowerCase();
  if (status === 404 && useProxy) {
    return new GeminiError('Die KI ist noch nicht eingerichtet. Tippe auf „Einrichten“ und hinterlege einmalig deinen kostenlosen Google-Schlüssel.', { status, retry: false, settings: true });
  }
  if (status === 400 && (d.includes('api key') || d.includes('api_key'))) {
    return new GeminiError('Der API-Schlüssel ist ungültig. Bitte in den Einstellungen prüfen.', { status, retry: false, settings: true });
  }
  if (status === 403) {
    return new GeminiError('Zugriff verweigert. Prüfe den API-Schlüssel bzw. ob die Gemini-API für das Projekt aktiv ist.', { status, retry: false, settings: true });
  }
  if (status === 404) {
    return new GeminiError(`Das Modell „${model}“ ist nicht verfügbar. Wähle in den Einstellungen ein anderes.`, { status, retry: false, settings: true });
  }
  if (status === 429) {
    return new GeminiError('Das kostenlose Kontingent ist gerade aufgebraucht. Warte eine Minute oder wähle ein anderes Modell (z. B. Flash-Lite).', { status, retry: true, settings: true });
  }
  if (status === 413 || (status === 400 && d.includes('size'))) {
    return new GeminiError('Die Bilder sind zu groß für eine Anfrage. Bitte weniger Fotos verwenden.', { status, retry: false });
  }
  if (status >= 500) {
    return new GeminiError('Gemini ist gerade überlastet. Bitte gleich nochmal versuchen.', { status, retry: true });
  }
  return new GeminiError(`Fehler von Gemini (${status})${detail ? ': ' + detail : ''}`, { status, retry: true });
}
