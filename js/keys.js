// Foto-Coach – alles rund um den Gemini-Schlüssel: Format, Prüfung, Proxy-Erkennung, Zwischenablage, QR-Übergabe

// Google vergibt seit Mai 2026 neue "Auth Keys" (beginnen mit "AQ."), ältere beginnen mit "AIza".
// Schlüssel daher nicht am Präfix prüfen, nur grob an Zeichen und Länge.
const KEY_RE = /^[A-Za-z0-9._\-]{30,200}$/;

/** Säubert eingefügten Text (Leerzeichen, Anführungszeichen, "key=" usw.) */
export function cleanKey(text) {
  if (!text) return '';
  const t = String(text).replace(/^\s*(GEMINI_API_KEY|key)\s*[=:]\s*/i, '');
  const m = t.match(/(AQ\.[A-Za-z0-9._\-]{20,}|AIza[0-9A-Za-z_\-]{35}|[A-Za-z0-9._\-]{30,200})/);
  return m ? m[0] : t.trim().replace(/^["']|["']$/g, '');
}

export const looksLikeKey = (k) => KEY_RE.test(k || '');

/** Fragt bei Google die Modellliste ab – kostet kein Kontingent für Bildanalysen.
 *  Ergebnis: 'ok' | 'invalid' | 'denied' | 'offline' */
export async function testKey(key, signal) {
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, signal,
    });
    if (r.ok) return 'ok';
    if (r.status === 400 || r.status === 401) return 'invalid';
    if (r.status === 403) return 'denied';
    if (r.status === 429 || r.status >= 500) return 'ok'; // Schlüssel gültig, nur gerade ausgelastet
    return 'invalid';
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return 'offline';
  }
}

/** Server-Proxy vorhanden? Der Caddy-Block antwortet auf GET mit 403, ohne Proxy kommt 404. */
export async function probeProxy() {
  try {
    const r = await fetch('api/gemini/ping', { method: 'GET', cache: 'no-store' });
    return r.status === 403;
  } catch (_) { return false; }
}

export async function readClipboard() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText();
  } catch (_) { /* nicht erlaubt */ }
  return null;
}

/** Link, der den Schlüssel im #-Teil trägt – der #-Teil wird nie an einen Server geschickt. */
export function handoverUrl(key) {
  return location.origin + location.pathname + '#k=' + encodeURIComponent(key);
}

export function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return null;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/** Schlüssel aus dem Link übernehmen (#k=…) und den #-Teil sofort aus der Adresszeile entfernen. */
export function takeKeyFromHash() {
  const h = location.hash || '';
  if (!h.startsWith('#k=')) return null;
  const key = cleanKey(decodeURIComponent(h.slice(3)));
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { location.hash = ''; }
  return looksLikeKey(key) ? key : null;
}
