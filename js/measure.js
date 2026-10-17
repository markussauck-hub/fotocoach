// Foto-Coach – Lernschleife: objektive Messwerte lokal im Browser (ohne KI)
//   Schärfe   : Laplace-Varianz, je Kachel (4×4) – maßgeblich ist die schärfste Kachel (Motiv darf vor unscharfem Hintergrund stehen)
//   Belichtung: Anteil ausgefressener / abgesoffener Pixel im Helligkeits-Histogramm
//   Verwacklung: Belichtungszeit aus EXIF im Verhältnis zur Brennweite (Kleinbild-äquivalent)

const MEASURE_LONG = 1024;

// Schwellen sind grob kalibriert (Testfotos + künstlich weichgezeichnete Varianten), keine Laborwerte.
export const SHARP_SOFT = 200;   // darunter: eher weich
export const SHARP_BLUR = 45;    // darunter: deutlich unscharf

/** @param {HTMLCanvasElement} src */
export function measure(src) {
  const s = Math.min(1, MEASURE_LONG / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * s)), h = Math.max(8, Math.round(src.height * s));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;

  const Y = new Float32Array(w * h);
  let hi = 0, lo = 0, sum = 0;
  for (let i = 0, j = 0; j < Y.length; i += 4, j++) {
    const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    Y[j] = y; sum += y;
    if (y >= 250) hi++; else if (y <= 6) lo++;
  }
  const n = Y.length;

  // Laplace (4er-Nachbarschaft) je Kachel
  const T = 4, tw = Math.floor(w / T), th = Math.floor(h / T);
  const vars = [];
  for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) {
    let a = 0, a2 = 0, k = 0;
    const x0 = Math.max(1, tx * tw), x1 = Math.min(w - 1, (tx + 1) * tw);
    const y0 = Math.max(1, ty * th), y1 = Math.min(h - 1, (ty + 1) * th);
    for (let y = y0; y < y1; y++) {
      const r = y * w;
      for (let x = x0; x < x1; x++) {
        const i = r + x;
        const L = Y[i - 1] + Y[i + 1] + Y[i - w] + Y[i + w] - 4 * Y[i];
        a += L; a2 += L * L; k++;
      }
    }
    if (k) vars.push(a2 / k - (a / k) ** 2);
  }
  vars.sort((p, q) => q - p);
  const sharp = vars[0] || 0;
  return {
    sharp: Math.round(sharp),
    sharpLevel: sharp < SHARP_BLUR ? 'unscharf' : sharp < SHARP_SOFT ? 'weich' : 'scharf',
    clipHi: +(hi / n * 100).toFixed(1),
    clipLo: +(lo / n * 100).toFixed(1),
    mean: Math.round(sum / n),
  };
}

/* ---------- EXIF (nur JPEG, nur die paar Felder, die wir brauchen) ---------- */
export async function readExif(blob) {
  try {
    const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      const marker = v.getUint16(o), len = v.getUint16(o + 2);
      if (marker === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      o += 2 + len;
    }
  } catch (_) {}
  return null;
}

function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const out = {};
  const readIfd = (off) => {
    const p = t + off;
    if (p + 2 > v.byteLength) return null;
    const n = u16(p); let sub = null;
    for (let i = 0; i < n; i++) {
      const e = p + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), vo = e + 8;
      const ptr = (type === 2 && cnt > 4) || type === 5 ? t + u32(vo) : vo;
      const val = () => {
        if (type === 3) return u16(vo);
        if (type === 4) return u32(vo);
        if (type === 5) { const d = u32(ptr + 4); return d ? u32(ptr) / d : 0; }
        if (type === 2) { let s = ''; for (let k = 0; k < cnt - 1 && ptr + k < v.byteLength; k++) s += String.fromCharCode(v.getUint8(ptr + k)); return s.trim(); }
        return null;
      };
      switch (tag) {
        case 0x010F: out.make = val(); break;
        case 0x0110: out.model = val(); break;
        case 0x8769: sub = u32(vo); break;
        case 0x829A: out.exposure = val(); break;
        case 0x829D: out.fnumber = val(); break;
        case 0x8827: out.iso = val(); break;
        case 0x920A: out.focal = val(); break;
        case 0xA405: out.focal35 = val(); break;
      }
    }
    return sub;
  };
  const sub = readIfd(u32(t + 4));
  if (sub) readIfd(sub);
  return Object.keys(out).length ? out : null;
}

/** Verwacklungsgefahr: Faustregel 1/Brennweite, Smartphones mit Stabilisator schaffen etwa das Doppelte. */
export function shakeRisk(exif) {
  if (!exif || !exif.exposure) return false;
  const f = exif.focal35 || (exif.focal ? exif.focal * 7 : 26);
  return exif.exposure > 2 / f;
}

export function fmtExposure(t) {
  if (!t) return '';
  return t >= 0.3 ? `${t.toFixed(1).replace('.', ',')} s` : `1/${Math.round(1 / t)} s`;
}

/** Messwerte als Klartext für die KI und als Chips für die Anzeige */
export function describe(m, exif) {
  const chips = [];
  const facts = [];
  const sharpTxt = { scharf: 'scharf', weich: 'eher weich', unscharf: 'deutlich unscharf' }[m.sharpLevel];
  chips.push({ ok: m.sharpLevel === 'scharf', warn: m.sharpLevel === 'weich', bad: m.sharpLevel === 'unscharf', text: `Schärfe: ${sharpTxt}` });
  facts.push(`Schärfe (schärfste Bildstelle): ${sharpTxt} (Laplace-Varianz ${m.sharp}; unter ${SHARP_BLUR} unscharf, unter ${SHARP_SOFT} weich; bei strukturarmen Motiven wie Nebel, Himmel oder glatten Flächen ist der Wert auch bei scharfen Fotos niedrig)`);

  let bel = 'ausgewogen', belOk = true;
  if (m.clipHi > 3) { bel = `${String(m.clipHi).replace('.', ',')} % ausgefressen`; belOk = false; }
  else if (m.clipLo > 8) { bel = `${String(m.clipLo).replace('.', ',')} % abgesoffen`; belOk = false; }
  else if (m.mean < 55) { bel = 'sehr dunkel'; belOk = false; }
  else if (m.mean > 205) { bel = 'sehr hell'; belOk = false; }
  chips.push({ ok: belOk, warn: !belOk, text: `Belichtung: ${bel}` });
  facts.push(`Belichtung: ${m.clipHi} % der Pixel reinweiß (ausgefressen), ${m.clipLo} % reinschwarz (abgesoffen), mittlere Helligkeit ${m.mean}/255`);

  if (exif) {
    const bits = [];
    if (exif.focal35) bits.push(`${exif.focal35} mm (KB)`);
    else if (exif.focal) bits.push(`${String(+exif.focal.toFixed(1)).replace('.', ',')} mm`);
    if (exif.fnumber) bits.push(`f/${String(+exif.fnumber.toFixed(1)).replace('.', ',')}`);
    if (exif.exposure) bits.push(fmtExposure(exif.exposure));
    if (exif.iso) bits.push(`ISO ${exif.iso}`);
    if (bits.length) {
      chips.push({ ok: true, info: true, text: bits.join(' · ') });
      facts.push(`Kameradaten: ${bits.join(', ')}${exif.model ? ` (${exif.model})` : ''}`);
    }
    if (shakeRisk(exif)) {
      chips.push({ warn: true, text: 'Verwacklungsgefahr' });
      facts.push('Belichtungszeit ist für die Brennweite lang – Verwacklungsgefahr.');
    }
  } else {
    facts.push('Kameradaten: keine (Foto ohne EXIF).');
  }
  return { chips, facts: facts.join('\n') };
}
