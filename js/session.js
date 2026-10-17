// Foto-Coach – letzte Auswertung samt Versuchen lokal sichern (IndexedDB, bleibt nur auf diesem Gerät).
// Wichtig am Handy: Beim Öffnen der Kamera-App kann der Browser den Tab aus dem Speicher werfen –
// dann lässt sich die Auswertung beim nächsten Öffnen fortsetzen.

const DB = 'fotocoach', STORE = 'session', KEY = 'last';
const MAX_AGE = 3 * 24 * 3600 * 1000;

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('kein IndexedDB')); return; }
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export async function saveSession(data) {
  try { await tx('readwrite', s => s.put({ ...data, ts: Date.now() }, KEY)); return true; } catch (_) { return false; }
}

export async function loadSession() {
  try {
    const d = await tx('readonly', s => s.get(KEY));
    if (!d || Date.now() - d.ts > MAX_AGE) return null;
    return d;
  } catch (_) { return null; }
}

export async function clearSession() {
  try { await tx('readwrite', s => s.delete(KEY)); } catch (_) {}
}
