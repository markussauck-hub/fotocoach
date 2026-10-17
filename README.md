# Foto-Coach

Web-App fürs Handy: Fotos von einem Ort machen → bei mehreren Fotos entsteht ein Panorama → Gemini kreist die besten Motive ein, nummeriert sie und erklärt, wie man sie fotografiert. Danach: Motiv fotografieren und Feedback vom Coach bekommen (Lernschleife).

**Live:** https://lincolnsoft.de/fotocoach/

## Deployment

Der Branch `main` **ist** die fertige Seite. Kein Build, keine Abhängigkeiten. Auf dem Lincolnsoft Server spiegelt ein Cronjob ihn jede Minute nach `~/server/site/fotocoach/`:

```
* * * * * BRANCH=main ~/repos/lincolnsoft-homestation/deploy/sync-tool.sh markussauck-hub/fotocoach fotocoach >> ~/repos/sync-tools.log 2>&1
```

Ablauf für eine neue Version: Änderung per Pull Request → mergen → spätestens nach einer Minute live.
Beim Spiegeln wird der Zielordner vorher geleert. Alles, was im Repo-Hauptordner liegt, ist also öffentlich erreichbar.

- **Versionsnummer** an drei Stellen gemeinsam hochzählen: `?v=…` in `index.html` (CSS und `app.js`), die Imports in `js/app.js` und `APP_VERSION` in `js/app.js`. Die Query-Strings sorgen dafür, dass Handys die neuen Dateien laden.
- Änderungen in `CHANGELOG.md` eintragen.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html` | Oberfläche: Aufnahme, Auswertung, Ergebnis, Dialoge (Einführung, Einrichtung, Einstellungen, Feedback) |
| `js/app.js` | Ablauf, Kamera, Ergebnis-Karten, Lernschleife, Speichern, Feedback-Formular |
| `js/gemini.js` | Gemini-Aufrufe: Motivsuche (`analyze`) und Bewertung eigener Fotos (`judge`), JSON-Schema |
| `js/stitch-worker.js` | Panorama im Web-Worker (OpenCV.js) |
| `js/measure.js` | Lernschleife: Schärfe, Belichtung, EXIF – lokal ohne KI |
| `js/session.js` | Letzte Auswertung + Versuche lokal sichern (IndexedDB) |
| `js/progress.js` | Geschätzter Fortschrittsbalken, lernt die Dauer pro Modell |
| `js/keys.js` | Eigener API-Schlüssel, QR-Übergabe, Erkennung des Server-Proxys |
| `vendor/` | OpenCV.js 4.12, qrcode-generator |

## Server-Seite (im Repo lincolnsoft-homestation)

- **Gemini-Proxy:** Caddy hängt unter `/fotocoach/api/gemini/…` den Schlüssel aus `~/.config/lincolnsoft/gemini.env` an. Die App nutzt ihn automatisch, wenn kein eigener Schlüssel eingetragen ist.
- **Feedback:** `POST /api/feedback` legt Textdateien unter `~/server/data/api/feedback/fotocoach/` ab. Übersicht fürs Handy unter https://lincolnsoft.de/api/feedback/ansicht (Passwort).
