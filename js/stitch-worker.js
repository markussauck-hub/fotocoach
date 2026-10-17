/* Foto-Coach – Panorama-Worker
 * Rudimentäres Stitching im Browser mit OpenCV.js:
 *   1. Zylinderprojektion jedes Fotos
 *   2. AKAZE-Merkmale (Fallback ORB) + Ratio-Test
 *   3. Eigene RANSAC-Ähnlichkeitstransformation (Skalierung, Drehung, Verschiebung)
 *   4. Optimale Naht (dynamische Programmierung) + schmaler Übergang + Helligkeitsausgleich
 *   5. Zuschnitt auf sauberes Rechteck, kleine Ecken per Inpainting gefüllt
 * Lässt sich ein Foto nicht anschließen, beginnt eine neue Gruppe (wird später einzeln analysiert).
 */
'use strict';

let cv = null;
let cvPromise = null;

function loadCv() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    try {
      importScripts('../vendor/opencv.js');
    } catch (e) {
      reject(new Error('OpenCV konnte nicht geladen werden: ' + e.message));
      return;
    }
    const started = Date.now();
    const poll = () => {
      const c = self.cv;
      if (c && typeof c.Mat === 'function' && typeof c.AKAZE === 'function') {
        // Wichtig: das cv-Objekt ist "thenable" -> nie direkt resolven/awaiten, sonst Endlosschleife
        try { new c.Mat().delete(); resolve({ cv: c }); return; } catch (_) { /* Runtime noch nicht bereit */ }
      }
      if (Date.now() - started > 60000) { reject(new Error('OpenCV-Start dauert zu lange')); return; }
      setTimeout(poll, 50);
    };
    poll();
  });
  return cvPromise;
}

const progress = (step, text) => self.postMessage({ type: 'progress', step, text });

/* ---------- Hilfsfunktionen ---------- */

function imageDataToMat(img) {
  const m = new cv.Mat(img.height, img.width, cv.CV_8UC4);
  m.data.set(img.data);
  return m;
}

function cylindrical(src, f) {
  const w = src.cols, h = src.rows, xc = w / 2, yc = h / 2;
  const mapX = new cv.Mat(h, w, cv.CV_32FC1);
  const mapY = new cv.Mat(h, w, cv.CV_32FC1);
  const mx = mapX.data32F, my = mapY.data32F;
  for (let x = 0; x < w; x++) {
    const th = (x - xc) / f;
    const X = Math.tan(th) * f + xc;
    const c = Math.cos(th);
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      mx[i] = X;
      my[i] = (y - yc) / c + yc;
    }
  }
  const out = new cv.Mat();
  cv.remap(src, out, mapX, mapY, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const white = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(255));
  const mask = new cv.Mat();
  cv.remap(white, mask, mapX, mapY, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  const k = cv.Mat.ones(5, 5, cv.CV_8U);
  cv.erode(mask, mask, k);
  k.delete(); white.delete(); mapX.delete(); mapY.delete();
  return { img: out, mask };
}

function features(img, mask, kind) {
  const gray = new cv.Mat();
  cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
  const det = kind === 'orb' ? new cv.ORB(4000) : new cv.AKAZE();
  if (kind === 'akaze') { try { det.setThreshold(0.0005); } catch (_) {} }
  const kps = new cv.KeyPointVector();
  const desc = new cv.Mat();
  det.detectAndCompute(gray, mask, kps, desc);
  const pts = new Float32Array(kps.size() * 2);
  for (let i = 0; i < kps.size(); i++) { const p = kps.get(i).pt; pts[2 * i] = p.x; pts[2 * i + 1] = p.y; }
  kps.delete(); gray.delete(); det.delete();
  return { pts, desc, n: pts.length / 2 };
}

function matchPairs(fa, fb) {
  // liefert Punktpaare: a (Bild i) -> b (Bild i-1)
  if (fa.n < 8 || fb.n < 8) return [];
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const mv = new cv.DMatchVectorVector();
  bf.knnMatch(fa.desc, fb.desc, mv, 2);
  const out = [];
  for (let i = 0; i < mv.size(); i++) {
    const m = mv.get(i);
    if (m.size() < 2) { m.delete(); continue; }
    const m0 = m.get(0), m1 = m.get(1);
    if (m0.distance < 0.78 * m1.distance) {
      out.push([fa.pts[2 * m0.queryIdx], fa.pts[2 * m0.queryIdx + 1], fb.pts[2 * m0.trainIdx], fb.pts[2 * m0.trainIdx + 1]]);
    }
    m.delete();
  }
  mv.delete(); bf.delete();
  return out;
}

/* Ähnlichkeitstransformation q = [a -b; b a] p + t, robust per RANSAC */
function fitSimilarity(pairs, idx) {
  let pxm = 0, pym = 0, qxm = 0, qym = 0;
  for (const i of idx) { const m = pairs[i]; pxm += m[0]; pym += m[1]; qxm += m[2]; qym += m[3]; }
  const n = idx.length; pxm /= n; pym /= n; qxm /= n; qym /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (const i of idx) {
    const m = pairs[i];
    const px = m[0] - pxm, py = m[1] - pym, qx = m[2] - qxm, qy = m[3] - qym;
    num1 += px * qx + py * qy; num2 += px * qy - py * qx; den += px * px + py * py;
  }
  const a = num1 / den, b = num2 / den;
  return { a, b, tx: qxm - (a * pxm - b * pym), ty: qym - (b * pxm + a * pym) };
}

function ransacSimilarity(pairs, thresh) {
  const n = pairs.length;
  if (n < 6) return null;
  let best = null, bestCount = 0;
  const th2 = thresh * thresh;
  for (let it = 0; it < 2500; it++) {
    const i = (Math.random() * n) | 0; let j = (Math.random() * n) | 0;
    if (i === j) continue;
    const P = pairs[i], Q = pairs[j];
    const dpx = Q[0] - P[0], dpy = Q[1] - P[1], dqx = Q[2] - P[2], dqy = Q[3] - P[3];
    const d = dpx * dpx + dpy * dpy;
    if (d < 400) continue; // Punkte zu nah beieinander
    const a = (dqx * dpx + dqy * dpy) / d, b = (dqy * dpx - dqx * dpy) / d;
    const s = Math.hypot(a, b);
    if (s < 0.7 || s > 1.4) continue;
    const tx = P[2] - (a * P[0] - b * P[1]), ty = P[3] - (b * P[0] + a * P[1]);
    let c = 0;
    for (let k = 0; k < n; k++) {
      const m = pairs[k];
      const ex = a * m[0] - b * m[1] + tx - m[2], ey = b * m[0] + a * m[1] + ty - m[3];
      if (ex * ex + ey * ey < th2) c++;
    }
    if (c > bestCount) { bestCount = c; best = { a, b, tx, ty }; }
  }
  if (!best) return null;
  // Verfeinern auf allen Inliern (2 Runden)
  let model = best, inl = [];
  for (let round = 0; round < 2; round++) {
    inl = [];
    for (let k = 0; k < n; k++) {
      const m = pairs[k];
      const ex = model.a * m[0] - model.b * m[1] + model.tx - m[2], ey = model.b * m[0] + model.a * m[1] + model.ty - m[3];
      if (ex * ex + ey * ey < th2) inl.push(k);
    }
    if (inl.length < 6) break;
    model = fitSimilarity(pairs, inl);
  }
  return { ...model, inliers: inl.length, total: n };
}

const compose = (A, B) => ({ // A∘B (erst B, dann A)
  a: A.a * B.a - A.b * B.b,
  b: A.b * B.a + A.a * B.b,
  tx: A.a * B.tx - A.b * B.ty + A.tx,
  ty: A.b * B.tx + A.a * B.ty + A.ty,
});
const apply = (T, x, y) => [T.a * x - T.b * y + T.tx, T.b * x + T.a * y + T.ty];

/* Begradigen: die Kette der Bildmitten soll waagerecht liegen,
 * sonst "kippt" das Panorama und der Zuschnitt verliert viel Höhe. */
function level(items, transforms) {
  const centers = items.map((it, i) => apply(transforms[i], it.img.cols / 2, it.img.rows / 2));
  const n = centers.length;
  const mx = centers.reduce((s, c) => s + c[0], 0) / n, my = centers.reduce((s, c) => s + c[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of centers) { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
  const slope = sxx > 0 ? Math.atan(sxy / sxx) : 0;
  const meanRot = transforms.reduce((s, T) => s + Math.atan2(T.b, T.a), 0) / n;
  // Mittelweg aus Kettenneigung und mittlerer Bilddrehung
  const ang = -(0.5 * slope + 0.5 * meanRot);
  const R = { a: Math.cos(ang), b: Math.sin(ang), tx: 0, ty: 0 };
  return transforms.map(T => compose(R, T));
}

/* ---------- Zusammensetzen einer Gruppe ---------- */

function composite(items, transforms, maxWidth) {
  // Leinwandgröße bestimmen
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  items.forEach((it, i) => {
    const w = it.img.cols, h = it.img.rows;
    for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
      const [X, Y] = apply(transforms[i], x, y);
      minX = Math.min(minX, X); minY = Math.min(minY, Y); maxX = Math.max(maxX, X); maxY = Math.max(maxY, Y);
    }
  });
  let k = 1;
  if (maxX - minX > maxWidth) k = maxWidth / (maxX - minX);
  const W = Math.ceil((maxX - minX) * k) + 2, H = Math.ceil((maxY - minY) * k) + 2;
  const shift = { a: k, b: 0, tx: -minX * k + 1, ty: -minY * k + 1 };

  const res = new Uint8ClampedArray(W * H * 4);
  const resMask = new Uint8Array(W * H);
  const dsize = new cv.Size(W, H);

  items.forEach((it, i) => {
    progress('blend', `Füge Foto ${it.index + 1} ein …`);
    const T = compose(shift, transforms[i]);
    const M = cv.matFromArray(2, 3, cv.CV_64FC1, [T.a, -T.b, T.tx, T.b, T.a, T.ty]);
    const wi = new cv.Mat(), wm = new cv.Mat();
    cv.warpAffine(it.img, wi, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
    cv.warpAffine(it.mask, wm, M, dsize, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const kk = cv.Mat.ones(3, 3, cv.CV_8U); cv.erode(wm, wm, kk); kk.delete();
    const img = wi.data, msk = wm.data;

    if (i === 0) {
      for (let p = 0; p < W * H; p++) if (msk[p]) { resMask[p] = 1; const q = p * 4; res[q] = img[q]; res[q + 1] = img[q + 1]; res[q + 2] = img[q + 2]; res[q + 3] = 255; }
    } else {
      // Überlappung + Helligkeitsausgleich
      let x0 = W, x1 = -1, y0 = H, y1 = -1, cnt = 0;
      const sumR = [0, 0, 0], sumN = [0, 0, 0];
      let newOnlyX = 0, newOnlyN = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!msk[p]) continue;
        if (resMask[p]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          if ((x + y) % 2 === 0) { const q = p * 4; for (let c = 0; c < 3; c++) { sumR[c] += res[q + c]; sumN[c] += img[q + c]; } cnt++; }
        } else { newOnlyX += x; newOnlyN++; }
      }
      const gain = [1, 1, 1];
      if (cnt > 500) for (let c = 0; c < 3; c++) gain[c] = Math.min(1.35, Math.max(0.75, sumR[c] / Math.max(1, sumN[c])));
      for (let p = 0; p < W * H; p++) if (msk[p]) { const q = p * 4; img[q] = Math.min(255, img[q] * gain[0]); img[q + 1] = Math.min(255, img[q + 1] * gain[1]); img[q + 2] = Math.min(255, img[q + 2] * gain[2]); }

      const dir = (x1 >= x0 && newOnlyN && newOnlyX / newOnlyN < (x0 + x1) / 2) ? -1 : 1; // neues Bild links oder rechts
      const seam = new Float32Array(H).fill(dir > 0 ? -1 : W + 1);
      if (x1 > x0 && y1 > y0) {
        // Minimalkosten-Naht von oben nach unten durch die Überlappung
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1, margin = Math.min(25, Math.floor(bw / 6));
        const acc = new Float32Array(bw * bh), back = new Int8Array(bw * bh);
        for (let yy = 0; yy < bh; yy++) {
          for (let xx = 0; xx < bw; xx++) {
            const x = x0 + xx, y = y0 + yy, p = y * W + x, q = p * 4;
            let c;
            if (msk[p] && resMask[p]) {
              c = Math.abs(res[q] - img[q]) + Math.abs(res[q + 1] - img[q + 1]) + Math.abs(res[q + 2] - img[q + 2]);
              if (xx < margin || xx >= bw - margin) c += 400;
            } else c = 5000;
            const o = yy * bw + xx;
            if (yy === 0) { acc[o] = c; continue; }
            let best = acc[o - bw], bi = 0;
            if (xx > 0 && acc[o - bw - 1] < best) { best = acc[o - bw - 1]; bi = -1; }
            if (xx < bw - 1 && acc[o - bw + 1] < best) { best = acc[o - bw + 1]; bi = 1; }
            acc[o] = c + best; back[o] = bi;
          }
        }
        let bx = 0, bv = Infinity;
        for (let xx = 0; xx < bw; xx++) { const v = acc[(bh - 1) * bw + xx]; if (v < bv) { bv = v; bx = xx; } }
        for (let yy = bh - 1; yy >= 0; yy--) { seam[y0 + yy] = x0 + bx; bx = Math.max(0, Math.min(bw - 1, bx + back[yy * bw + bx])); }
        for (let y = 0; y < y0; y++) seam[y] = seam[y0];
        for (let y = y1 + 1; y < H; y++) seam[y] = seam[y1];
      }
      const F = 10; // halbe Übergangsbreite in Pixeln
      for (let y = 0; y < H; y++) {
        const sx = seam[y];
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          if (!msk[p]) continue;
          const q = p * 4;
          if (!resMask[p]) { res[q] = img[q]; res[q + 1] = img[q + 1]; res[q + 2] = img[q + 2]; res[q + 3] = 255; resMask[p] = 1; continue; }
          const w = Math.max(0, Math.min(1, 0.5 + (dir * (x - sx)) / (2 * F)));
          if (w <= 0) continue;
          res[q] = res[q] * (1 - w) + img[q] * w;
          res[q + 1] = res[q + 1] * (1 - w) + img[q + 1] * w;
          res[q + 2] = res[q + 2] * (1 - w) + img[q + 2] * w;
        }
      }
    }
    M.delete(); wi.delete(); wm.delete();
  });

  return cropAndFill(res, resMask, W, H);
}

function cropAndFill(res, mask, W, H) {
  const xa0 = Math.floor(W * 0.03), xa1 = Math.ceil(W * 0.97);
  let y0 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    let v = 0; for (let x = xa0; x < xa1; x++) v += mask[y * W + x];
    if (v / (xa1 - xa0) > 0.92) { if (y0 < 0) y0 = y; y1 = y; }
  }
  if (y0 < 0) { y0 = 0; y1 = H - 1; }
  let x0 = -1, x1 = -1;
  for (let x = 0; x < W; x++) {
    let v = 0; for (let y = y0; y <= y1; y++) v += mask[y * W + x];
    if (v / (y1 - y0 + 1) > 0.96) { if (x0 < 0) x0 = x; x1 = x; }
  }
  if (x0 < 0) { x0 = 0; x1 = W - 1; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const rgb = new cv.Mat(ch, cw, cv.CV_8UC3), hole = new cv.Mat(ch, cw, cv.CV_8UC1);
  let holes = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const p = (y + y0) * W + (x + x0), o = y * cw + x;
    rgb.data[o * 3] = res[p * 4]; rgb.data[o * 3 + 1] = res[p * 4 + 1]; rgb.data[o * 3 + 2] = res[p * 4 + 2];
    const hv = mask[p] ? 0 : 255; hole.data[o] = hv; if (hv) holes++;
  }
  if (holes > 0) {
    const k = cv.Mat.ones(5, 5, cv.CV_8U); cv.dilate(hole, hole, k); k.delete();
    const filled = new cv.Mat();
    cv.inpaint(rgb, hole, filled, 6, cv.INPAINT_TELEA); // C++-Reihenfolge: src, mask, dst
    filled.copyTo(rgb); filled.delete();
  }
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let o = 0; o < cw * ch; o++) { out[o * 4] = rgb.data[o * 3]; out[o * 4 + 1] = rgb.data[o * 3 + 1]; out[o * 4 + 2] = rgb.data[o * 3 + 2]; out[o * 4 + 3] = 255; }
  rgb.delete(); hole.delete();
  return { width: cw, height: ch, data: out, holes };
}

/* ---------- Ablauf ---------- */

async function stitch(images, opts) {
  progress('load', 'Lade Bildverarbeitung …');
  cv = (await loadCv()).cv;
  // Brennweite relativ zur langen Bildseite; Handy-Hauptkamera (~26 mm KB) liegt bei ca. 0,75–1,0
  const focal = opts.focal || 0.9;
  const items = [];
  for (let i = 0; i < images.length; i++) {
    progress('prep', `Bereite Foto ${i + 1} von ${images.length} vor …`);
    const src = imageDataToMat(images[i]);
    const cyl = cylindrical(src, focal * Math.max(src.cols, src.rows));
    src.delete();
    items.push({ index: i, img: cyl.img, mask: cyl.mask });
  }

  // Paarweise anschließen, bei Fehlschlag neue Gruppe
  const groups = [];
  let cur = { items: [items[0]], transforms: [{ a: 1, b: 0, tx: 0, ty: 0 }] };
  const log = [];
  let prevFeat = { akaze: features(items[0].img, items[0].mask, 'akaze') };
  for (let i = 1; i < items.length; i++) {
    progress('match', `Suche Überlappung zwischen Foto ${i} und ${i + 1} …`);
    const it = items[i];
    let result = null, used = '';
    const fa = features(it.img, it.mask, 'akaze');
    const pairs = matchPairs(fa, prevFeat.akaze);
    result = ransacSimilarity(pairs, 4); used = 'akaze';
    const curFeat = { akaze: fa };
    const ok = (r) => r && r.inliers >= 25 && r.inliers / Math.max(1, r.total) >= 0.12 &&
      Math.hypot(r.a, r.b) > 0.8 && Math.hypot(r.a, r.b) < 1.25 && Math.abs(Math.atan2(r.b, r.a)) < 0.21;
    if (!ok(result)) {
      // zweiter Versuch mit ORB
      const oa = features(it.img, it.mask, 'orb');
      const ob = features(items[i - 1].img, items[i - 1].mask, 'orb');
      const r2 = ransacSimilarity(matchPairs(oa, ob), 4);
      oa.desc.delete(); ob.desc.delete();
      if (ok(r2) && (!result || r2.inliers > result.inliers)) { result = r2; used = 'orb'; }
    }
    const entry = { from: i, to: i - 1, method: used, inliers: result ? result.inliers : 0, matches: result ? result.total : pairs.length };
    if (ok(result)) {
      entry.ok = true;
      entry.scale = +Math.hypot(result.a, result.b).toFixed(3);
      entry.rotDeg = +(Math.atan2(result.b, result.a) * 180 / Math.PI).toFixed(2);
      entry.shiftX = Math.round(result.tx);
      const prevT = cur.transforms[cur.transforms.length - 1];
      cur.items.push(it); cur.transforms.push(compose(prevT, result));
    } else {
      entry.ok = false;
      groups.push(cur);
      cur = { items: [it], transforms: [{ a: 1, b: 0, tx: 0, ty: 0 }] };
    }
    log.push(entry);
    prevFeat.akaze.desc.delete();
    prevFeat = curFeat;
  }
  prevFeat.akaze.desc.delete();
  groups.push(cur);

  const out = [];
  for (const g of groups) {
    const indices = g.items.map(it => it.index);
    if (g.items.length === 1) { out.push({ indices, panorama: null }); continue; }
    progress('blend', `Setze ${g.items.length} Fotos zusammen …`);
    const pano = composite(g.items, level(g.items, g.transforms), opts.maxWidth || 6000);
    out.push({ indices, panorama: pano });
  }
  items.forEach(it => { it.img.delete(); it.mask.delete(); });
  return { groups: out, log };
}

self.onmessage = async (e) => {
  const { type, images, opts } = e.data;
  if (type === 'warmup') { try { await loadCv(); self.postMessage({ type: 'ready' }); } catch (err) { self.postMessage({ type: 'error', message: err.message }); } return; }
  if (type !== 'stitch') return;
  try {
    const t0 = performance.now();
    const r = await stitch(images, opts || {});
    const transfer = [];
    r.groups.forEach(g => { if (g.panorama) { g.panorama.data = g.panorama.data.buffer; transfer.push(g.panorama.data); } });
    self.postMessage({ type: 'done', result: r, ms: Math.round(performance.now() - t0) }, transfer);
  } catch (err) {
    let message = (err && err.message) || String(err);
    if (typeof err === 'number' && cv && cv.exceptionFromPtr) { try { message = 'OpenCV: ' + cv.exceptionFromPtr(err).msg; } catch (_) {} }
    self.postMessage({ type: 'error', message });
  }
};
