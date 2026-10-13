# Ozu Web

Leichtgewichtiger osu!-Client im Browser (Canvas 2D + WebAudio). Keine Abhängigkeiten, kein Build-Schritt.
Unterstützte Modi: **osu!standard** (`Mode: 0`) und **osu!taiko** (`Mode: 1`). Catch/Mania werden erkannt und abgelehnt.

## Starten

- Einfach `index.html` per Doppelklick in Chrome/Edge/Firefox öffnen (es werden nur klassische Skripte verwendet, daher geht auch `file://`), oder
- `node serve.mjs` und dann <http://localhost:8080> öffnen.

Dann entweder eine **`.osz`** (Mapset) ins Fenster ziehen, **`.osu` + Audiodatei** gemeinsam auswählen, oder eine der **Demos** starten.
Eine `.osz` kann man aus `P:\osu\Songs\<Ordner>` erzeugen, indem man den Ordner als ZIP packt und in `.osz` umbenennt;
alternativ im Dateidialog die `.osu` und `audio.mp3` aus dem Ordner zusammen markieren.
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
