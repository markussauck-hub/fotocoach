# Änderungsverlauf

## v0.4.9: Willkommenskarte

- Beim **ersten Aufruf** erscheint eine Einführung: wozu der Foto-Coach da ist, drei Schritte (Umschauen → Motive entdecken → Besser werden) und ein Hinweis zu Kosten und Datenschutz. „Los geht's“ schließt sie, danach kommt sie nicht wieder.
- **Am PC** zeigt die Karte zusätzlich einen QR-Code mit dem Hinweis „Gedacht fürs Handy“.
- Die Kamera-Freigabe wird erst nach der Einführung abgefragt, nicht gleichzeitig.
- Wieder aufrufen: Zahnrad › „ℹ Einführung anzeigen“.

## v0.4.8: Speichern auf Android

- **Android und PC:** „💾 Speichern“ lädt das Originalfoto jetzt direkt herunter, in den Ordner `Download`. Galerie-Apps zeigen ihn als Album „Download“. Vorher öffnete sich das Teilen-Menü, und das bietet auf vielen Android-Handys, etwa von Xiaomi, gar kein „Auf Gerät speichern“ an. Zum Verschicken gibt es daneben „↗ Teilen“.
- **iPhone:** unverändert über das Teilen-Menü mit „Bild sichern“, das ist der einzige Weg in die Fotos-App.
- Nach dem Speichern sagt ein Hinweis, wo das Foto liegt. Der Dateiname von „Bild speichern“ nutzt jetzt deutsche Zeit.

## v0.4.7

- **„Nächster Versuch“ ist jetzt ein Knopf.** Ein Tipp öffnet direkt die Kamera für den nächsten Versuch, der Tipp des Coaches steht im Knopf. Darunter: „oder aus der Galerie“ für Fotos aus der Kamera-App mit Zoom und Porträtmodus. Vorher sah der Block nur wie ein Knopf aus.

## v0.4.6 (erstes Tester-Feedback)

- **„Weiter“ heißt jetzt „Auswerten“.** Ab dem ersten Foto pulsiert der Knopf, und der Hinweis beginnt mit „👉 Fertig? Tippe auf ‚Auswerten‘“. Vorher war nicht klar, dass ein Einzelfoto reicht.
- **Feedback-Knopf** ist jetzt ein beschrifteter gelber Knopf „Feedback“ (nur Text) statt des Sprechblasen-Symbols, das wie ein Chat aussah.
- Schmale Handys (bis 320 px): Die Steuerleiste läuft nicht mehr über den Rand, der Titel wird etwas kleiner.

## v0.4.5: Feedback-Knopf für Tester

- Sprechblase oben links öffnet das Formular: Art (🐞 Fehler / 💡 Idee / 👍 Lob / 💬 Sonstiges), Nachricht, Name und E-Mail freiwillig.
- „Technische Angaben mitsenden“ ist vorausgewählt und per „ansehen“ einsehbar: App-Version, Browser/Gerät, Bildschirm, KI-Einstellungen, Anzahl Fotos/Motive/Versuche, letzte Fehlermeldung. Keine Fotos, kein Schlüssel.
- Das Feedback landet als Textdatei auf dem Server: `~/server/data/api/feedback/fotocoach/JJJJ-MM-TT_HHMMSS_<art>.txt`. Geschrieben wird es vom bestehenden Kontakt-Dienst (`POST /api/feedback`, PR #3 im Repo lincolnsoft-homestation). Es wird keine Mail verschickt.
- Name und E-Mail werden auf dem Gerät gemerkt, damit Tester sie nicht jedes Mal neu eintippen.

## v0.4.4: Galerie gleichwertig

- Öffnet eine Web-App die Kamera, zeigt das Handy nur einen abgespeckten Aufnahme-Modus: je nach Hersteller ohne Porträtmodus, Zoomstufen und Einstellungen. Das lässt sich von der Web-App aus nicht ändern.
- Deshalb ist der Weg über die normale Kamera-App jetzt gleichwertig. Auf der Motivkarte gibt es zwei gleich große Knöpfe, **📷 Schnell-Foto** und **🖼 Aus Galerie**, mit Hinweis: „Für Porträtmodus, Zoom & Co.: mit der normalen Kamera-App fotografieren, dann ‚Aus Galerie‘.“
- Auf dem Startbildschirm ist „Aus Galerie“ jetzt ein richtiger Knopf mit demselben Hinweis.
- Nebeneffekt: Fotos aus der Kamera-App liegen schon in der Galerie, Speichern ist dann nicht nötig.

## v0.4.3: gelungene Fotos sichern

- Fotos aus „📷 Jetzt fotografieren“ landen auf Android und iPhone meist **nicht** in der Galerie. Darum hat jetzt jeder Versuch einen Knopf **💾 Speichern**. Bei mindestens zwei grünen Ampeln heißt er **⭐ Behalten** und ist hervorgehoben. Speichern geht aber immer, unabhängig von der Bewertung.
- Gespeichert wird die **Originaldatei**: volle Auflösung, unverändert, mit EXIF. Die verkleinerte Fassung dient nur der KI.
- Am Handy öffnet sich das Teilen-Menü: „Bild sichern“ auf dem iPhone, „Auf Gerät speichern“ oder Google Fotos auf Android. Am PC startet ein normaler Download. Dateiname zum Beispiel `fotocoach-20261015-0013-rostofen-mit-blauem-topf-v1.jpg`.
- Danach steht dort „✓ Gespeichert“. Fotos, die über „Foto wählen“ aus der Galerie kamen, sind als „Liegt schon in deiner Galerie“ markiert.
- **Warnung** bei „Neue Fotos“, solange Kamera-Fotos ungespeichert sind.
- Originale werden mit „Letzte Auswertung fortsetzen“ ebenfalls lokal gesichert.

## v0.4.2

- **Standardmodell ist jetzt Gemini 3.6 Flash**, weil 3.8 Flash oft überlastet ist. Ausweich-Reihenfolge: 3.6 Flash → 3.8 Flash → 3.5 Flash-Lite. Wer bisher 3.8 eingestellt hatte (der alte Standard), wird einmalig auf 3.6 umgestellt. Wer danach bewusst 3.8 wählt, behält es.

## v0.4.1: schneller + Fortschrittsbalken

- **Schneller:** Gemini 3.x Flash „denkt“ ohne Vorgabe auf Stufe *medium*, bevor es antwortet. Der Foto-Coach fragt jetzt mit Denkstufe *low* an. In den Einstellungen unter „Denkzeit der KI“ lässt sich auf „Gründlich“ (*medium*) zurückstellen. Kennt ein Modell die Stufe nicht, wiederholt die App die Anfrage automatisch ohne Vorgabe.
- **Geschätzter Fortschrittsbalken** bei der Motivsuche und beim Feedback mit „noch etwa X s“. Gemini meldet keinen echten Fortschritt. Der Balken richtet sich nach der Dauer, die das gewählte Modell auf diesem Gerät zuletzt gebraucht hat, wird mit jeder Nutzung genauer und bleibt bei 95 % stehen, bis die Antwort da ist.
- Neu: `js/progress.js`. Alle Dateien werden mit `?v=0.4.1` geladen.

## v0.4: Lernschleife

Motiv finden → fotografieren → Feedback vom Coach.

- **Pro Motivkarte „📷 Jetzt fotografieren“** öffnet die Kamera-App (volle Auflösung, mit EXIF). „Foto wählen“ nimmt ein Bild aus der Galerie.
- **Lokale Messung ohne KI:** Schärfe (Laplace-Varianz, schärfste Bildstelle), Belichtung (Anteil ausgefressener/abgesoffener Pixel), Kameradaten aus EXIF und Verwacklungsgefahr (Belichtungszeit vs. Brennweite). Die Werte erscheinen als Chips und gehen als Fakten an Gemini – damit die KI keine Unschärfe erfindet.
- **Feedback im Ton „Fotokurs-Lehrer“:** ✅ Gelungen → Ampel für Perspektive, Bildaufbau, Licht (gemessen an den eigenen Tipps) → 🔧 bis zu 3 Verbesserungen, ortsbezogene mit Markierung A/B/C im Foto → ➡️ ein Satz für den nächsten Versuch. Keine Punktzahl.
- **Mehrere Versuche:** Streifen „Versuch 1, 2, 3 …“; ab Versuch 2 vergleicht der Coach mit dem letzten Feedback („📈 Gegenüber dem letzten Versuch“).
- **Falsches Motiv** wird erkannt („🤔 Anderes Motiv?“) – dann kein Feedback, sondern ein Hinweis.
- **Übersicht:** „Fotografiert: 2 von 5 Motiven“, grünes Häkchen am Motiv im Bild.
- **Fortsetzen:** Auswertung und Versuche werden lokal gesichert (IndexedDB, 3 Tage). Wirft der Browser den Tab beim Öffnen der Kamera-App aus dem Speicher, steht auf dem Startbildschirm „↩ Letzte Auswertung fortsetzen“.
- **Schlüssel:** Knopf „🗑 Löschen“ (sofort gespeichert, 5 s „Rückgängig“) und Statuszeile: 🔑 eigener Schlüssel (…letzte 4 Zeichen) / 🟢 Server-Schlüssel aktiv / 🟡 kein Schlüssel.

Jeder Feedback-Aufruf ist ein Gemini-Aufruf (2 Bilder) über den Server-Schlüssel.

## Aktualisieren auf dem Server

Den Inhalt des Ordners `fotocoach` nach `~/server/site/fotocoach/` kopieren und vorhandene Dateien überschreiben. Neu sind `js/measure.js` und `js/session.js`. Die Dateien werden mit `?v=0.4` geladen, ein Neuladen am Handy reicht.

Fotos von einem Ort machen → bei mehreren Fotos entsteht ein Panorama → Gemini kreist die besten Motive ein, nummeriert sie und erklärt, wie man sie fotografiert.

## v0.3.1

- Neue Google-Schlüssel (beginnen mit **„AQ.“**, seit Mai 2026 Standard in AI Studio) werden akzeptiert. Vorher lehnte die App alles ab, was nicht mit „AIza“ begann.

## v0.3

- **Kamera-Knopf** links neben dem Auslöser: öffnet direkt die Kamera-App des Handys (volle Auflösung). Der Live-Sucher bleibt für Panoramen mit Überlappungshilfe. Die Galerie ist darunter als Textknopf.
- **Einfache Schlüssel-Einrichtung:** Ohne Schlüssel (und ohne Server-Proxy) erscheint ein gelber Hinweis; spätestens bei „Weiter“ öffnet sich „Einmalig einrichten“: Link zu Google → „Schlüssel einfügen“ (liest die Zwischenablage) → automatische Prüfung bei Google → Fertig, und die Auswertung läuft direkt los.
- **Übergabe per QR-Code:** Am PC in den Einstellungen Schlüssel einfügen → „Aufs Handy (QR)“ → mit dem Handy scannen. Der Schlüssel steckt im `#`-Teil des Links, der nie an einen Server geht, und wird nach dem Übernehmen sofort aus der Adresszeile gelöscht.
- **Server-Proxy wird automatisch erkannt:** Ist Variante B eingerichtet, fragt die App gar nicht erst nach einem Schlüssel.

## v0.2

- **„Nochmal versuchen“ setzt das Panorama nicht mehr neu zusammen** – das fertige Panorama wird wiederverwendet, solange die Fotos gleich sind.
- **Überlastung (Fehler 500/503):** automatisch ein zweiter Versuch nach 4 s mit sichtbarem Countdown.
- **Ausweich-Modell:** bleibt das Modell überlastet (oder ist das Kontingent leer, 429), wird automatisch das nächste genommen: 3.6 Flash → 3.8 Flash → 3.5 Flash-Lite (seit v0.4.2). Im Ergebnis steht dann, welches Modell ausgewertet hat. Abschaltbar in den Einstellungen.

## Inhalt

```
fotocoach/
├── index.html              Oberfläche (3 Schritte: Aufnahme, Auswertung, Ergebnis)
├── manifest.webmanifest    „Zum Startbildschirm hinzufügen“
├── css/app.css             LincolnSoft-Stil (Orbitron, Chakra Petch, Martian Mono, Glas-Buttons)
├── js/app.js               Kamera, Ablauf, Zeichnen der Markierungen, Ergebnis-Karten
├── js/gemini.js            Gemini-Aufruf (generateContent + JSON-Schema, box_2d)
├── js/keys.js              Schlüssel prüfen, Zwischenablage, QR-Übergabe, Proxy-Erkennung
├── js/measure.js           Lernschleife: Schärfe, Belichtung, EXIF (lokal)
├── js/session.js           Auswertung + Versuche lokal sichern (IndexedDB)
├── js/progress.js          geschätzter Fortschrittsbalken (lernt die Dauer pro Modell)
├── js/stitch-worker.js     Panorama im Web-Worker (OpenCV.js)
├── vendor/qrcode.js        QR-Code-Generator (MIT)
├── vendor/opencv.js        OpenCV.js 4.12 (10,9 MB, wird nur bei mehreren Fotos geladen)
└── icons/                  App-Icons
```

Keine Build-Tools, kein Framework. Statische Dateien hochladen und fertig.

## So funktioniert's

| Schritt | Was passiert | Wo |
|---|---|---|
| Aufnahme | Live-Sucher mit Rückkamera. Ab dem 2. Foto wird das rechte Drittel des letzten Fotos links eingeblendet (Überlappungshilfe). Alternativ: Galerie oder Kamera-App. Max. 8 Fotos. | Browser |
| Panorama (nur bei ≥ 2 Fotos) | Zylinderprojektion → AKAZE-Merkmale (Fallback ORB) → eigene RANSAC-Ähnlichkeitstransformation → Begradigen → optimale Naht + Helligkeitsausgleich → Zuschnitt. Passt ein Foto nicht an das vorige, beginnt eine neue Gruppe und es wird einzeln ausgewertet. | Web-Worker, ~6 s für 3 Fotos (Desktop-Chromium) |
| KI-Analyse | Ein einziger Aufruf mit allen Bildern. Gemini liefert JSON: Motiv, Bildnummer, `box_2d` (0–1000), Warum, Perspektive, Bildaufbau, Kamera, Licht, Standort. | Gemini |
| Ergebnis | Gelbe Ringe mit Nummern. Antippen einer Karte springt zum Motiv und färbt es cyan. Speichern/Teilen als JPG. | Browser |

Die Fotos verlassen das Gerät nur für den Gemini-Aufruf. Es gibt keine Speicherung auf dem Server.

## Variante A: Schnelltest mit eigenem API-Schlüssel

1. Kostenlosen Schlüssel holen: <https://aistudio.google.com/apikey>. **Wichtig:** in einem Google-Cloud-Projekt **ohne** Abrechnungskonto, dann kann nichts kosten.
2. Ordner `fotocoach` nach `L:\server\site\fotocoach\` kopieren → erreichbar unter `https://lincolnsoft.de/fotocoach/`.
3. Am Handy öffnen → Zahnrad → Schlüssel eintragen → Speichern.

Die Kamera braucht HTTPS. Das liefert Caddy bereits.

## Variante B: Ohne Schlüssel am Handy (Server-Proxy)

Dann liegt der Schlüssel nur auf dem Server. Die App nutzt automatisch `fotocoach/api/gemini/…`, wenn in den Einstellungen kein Schlüssel eingetragen ist.

**1. Schlüssel als Umgebungsvariable** – in `~/server/.env` (Rechte: `chmod 600 ~/server/.env`):

```
GEMINI_API_KEY=dein-schluessel
```

**2. In `~/server/docker-compose.yml` beim Caddy-Dienst ergänzen:**

```yaml
    environment:
      - GEMINI_API_KEY=${GEMINI_API_KEY}
```

**3. Im Caddyfile innerhalb des Blocks `lincolnsoft.de { … }` ergänzen** (vor `file_server`):

```caddy
    # Foto-Coach: Gemini-Proxy, erlaubt nur generateContent auf Gemini-Modellen
    handle_path /fotocoach/api/gemini/* {
        @gemini path_regexp ^/v1beta/models/gemini-[a-z0-9.\-]+:generateContent$
        handle @gemini {
            request_body {
                max_size 25MB
            }
            reverse_proxy https://generativelanguage.googleapis.com {
                header_up Host {upstream_hostport}
                header_up x-goog-api-key {env.GEMINI_API_KEY}
                header_up -Cookie
                header_up -Referer
            }
        }
        handle {
            respond 403
        }
    }
```

Falls deine statischen Seiten im Caddyfile schon in einem `handle { … }`-Block liegen, setze den `handle_path`-Block **davor**.

**4. Neu starten:**

```bash
cd ~/server && docker compose up -d --force-recreate caddy
docker compose logs --tail=30 caddy
```

**Test vom Server aus** (sollte JSON mit `candidates` liefern):

```bash
curl -s https://lincolnsoft.de/fotocoach/api/gemini/v1beta/models/gemini-3.8-flash:generateContent \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"Sag Hallo"}]}]}' | head -c 400
```

**Grenze von Variante B:** Der Proxy hat keine Ratenbegrenzung, da das Standard-Caddy-Image kein Rate-Limit-Modul enthält. Wer die URL kennt, kann dein kostenloses Kontingent mitnutzen. Solange das Projekt kein Abrechnungskonto hat, entstehen keine Kosten, im schlimmsten Fall ist das Tageskontingent leer. Für eine öffentliche App wäre der nächste Schritt ein kleiner Node-Container mit Limit pro IP.

## Bekannte Grenzen des Prototyps

- **Panorama:** setzt voraus, dass die Fotos in Aufnahmereihenfolge kommen und sich etwa ein Drittel überlappen. Schwenks nach oben/unten werden nicht unterstützt.
- **Live-Sucher** nimmt Video-Einzelbilder auf (je nach Handy 1080p–4K), nicht die volle Foto-Auflösung. Für die Analyse reicht das. Wer volle Auflösung will, nimmt „Galerie“ oder die Kamera-App.
- **Gemini-Kontingent:** Im kostenlosen Kontingent sind die Limits pro Minute und Tag begrenzt. Bei Fehler 429 hilft Warten oder Flash-Lite.
- **Datenschutz:** Im kostenlosen Kontingent darf Google die Inhalte zur Produktverbesserung nutzen. Ein Hinweis steht in den Einstellungen.
- **Schärfe-Messung** ist grob kalibriert. Bei strukturarmen Motiven (Nebel, Himmel, glatte Flächen) kann sie „weich“ melden, obwohl das Foto scharf ist. Das weiß auch die KI.
- **HEIC-Fotos** (iPhone-Standard) kann nicht jeder Browser öffnen. Dann erscheint ein Hinweis; in der Kamera-App „Maximale Kompatibilität“ (JPG) wählen.
- Getestet wurde in Chromium (Handy-Ansicht, simulierte Kamera) mit einer **simulierten** Gemini-Antwort. Der echte Gemini-Aufruf ist noch ungetestet und braucht deinen Schlüssel.
