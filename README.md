# Ozu Web

Leichtgewichtiger osu!-Client im Browser (Canvas 2D + WebAudio). Keine Abhängigkeiten, kein Build-Schritt.
Unterstützte Modi: **osu!standard** (`Mode: 0`) und **osu!taiko** (`Mode: 1`). Catch/Mania werden erkannt und abgelehnt.

## Starten

- Einfach `index.html` per Doppelklick in Chrome/Edge/Firefox öffnen (es werden nur klassische Skripte verwendet, daher geht auch `file://`), oder
- `node serve.mjs` und dann <http://localhost:8080> öffnen.

## Beatmaps importieren

- **`.osz`** ins Fenster ziehen oder über die Dateiauswahl wählen (mehrere gleichzeitig möglich),
- **`.osu` + Musik (+ Bild)** gemeinsam auswählen,
- oder **Ordner importieren** (z. B. `P:\osu\Songs` oder ein einzelner Song-Ordner).

Importierte Sets liegen in der **Bibliothek** (IndexedDB, nur lokal im Browser) und bleiben nach einem Neuladen erhalten. Suche und Löschen (✕) sind eingebaut.

## Latenz / Performance

Standard ist der Minimal-Modus: **keine Effekte** (Fade-Outs, Snaking, Trail, Popups), Slider verschwinden sofort, Slider-Körper werden vorab als Bitmap gerendert,
**Hardware-Cursor** (kein Canvas-Cursor), Hitsounds aus vorberechneten Buffers, Zeitgeber auf `performance.now()` mit Audio-Drift-Korrektur,
Eingaben werden mit dem exakten Event-Zeitstempel gewertet. Optional: Raw-Input (Maus sperren), Render-Auflösung 75 %/50 %.
Die Dateien bleiben lokal im Browser. osu! selbst wird nicht angefasst.

## Steuerung

| Modus | Eingabe |
| --- | --- |
| Standard | Maus bewegen, `Z`/`X` oder Maustasten |
| Taiko | `F`/`J` = Don (rot), `D`/`K` = Kat (blau), Maustasten links/rechts |
| Beide | `Esc` Pause, `` ` `` Neustart |

## Stand

Umgesetzt: Parser (Timing, SV, Kombos, Slider-Kurven B/L/P/C, Ticks, Wiederholungen, Spinner), OD/CS/AR-Formeln,
Fenster-Treffererkennung mit Note-Lock, Slider-Tracking (Head/Ticks/Repeats/Ende), Spinner, Taiko-Noten/Drumroll/Swell
mit SV-korrektem Scrollen, Score/Combo/Genauigkeit/Health/Rang, Pause, Audio-Offset, Render-Auflösung für schwache PCs,
Autoplay zum Testen.

Fehlt noch: Stacking, Skins, Storyboards, Mods, Hitsounds aus der Map (statt synthetischer Klicks), Breaks,
exakte osu!-Score-/Rang-Formeln, Taiko-Finisher-Doppeltreffer, Hintergrundbilder.

## Tests

`node test/parser.test.js`
