# rutekita-data

Data that the RuteKita app fetches at runtime, so it can change without an app release.

## `cctv/v1.json`

Public CCTV cameras at or near Jabodetabek rail stations (KRL, MRT, LRT), plus toll-road and city
road cameras.

- **Links only.** Video plays straight from each camera owner's server. Nothing here stores,
  records or re-streams video.
- **Official sources only:** DJKA Kemenhub, Pemprov DKI Jakarta, Pemkot Bekasi, Pemkot Bogor,
  Dishub Kota Depok, the toll-road operators as listed by BPJT Kementerian PU, and Pemprov Banten.
  Each camera names its source and links its owner's page (`page`) for attribution. A toll camera's
  owner is its operator (badan usaha jalan tol); its page is BPJT's CCTV page.
- Camera owners who want a camera removed: open an issue and it will be taken out.

### Fields

| Field | Meaning |
|---|---|
| `station` | RuteKita station code, e.g. `MRI` (Manggarai) or `mrt:bundaran-hi`. Optional for `road` cameras: set only when one stands within 400 m of a station |
| `kind` | `station` = inside the station; `street` = public road next to it; `road` = a toll road or city road, not tied to a station |
| `area` | `road` only: the toll road or region the camera watches, e.g. `Tol JORR S`; the app groups road cameras by it |
| `play.type` | `hls` = an `.m3u8` stream for the app's video player; `page` = the owner's player page, opened in a web view |
| `play.web` | `hls` only: `true` when the stream allows playback from other websites (CORS `*`). When `false`, the web version links to `page` instead |
| `lat`, `lon` | Where the owner publishes the camera's position; required for `road` cameras |

Bump `version` (and the file name) only for a change older apps cannot read. Adding cameras or
sources is not such a change, and neither is `road`: apps from before it skip those cameras.

### Road cameras

The `tol-*` and `banten` cameras are built, not hand-written. The builder reads BPJT's CCTV page
(https://bpjt.pu.go.id/cctv/) and the Pemprov Banten list (https://cctv.bantenprov.go.id), keeps
the cameras inside Jabodetabek whose stream answers right now, and replaces those sources' cameras
in `cctv/v1.json`; every other camera stays as written. Run it again to pick up cameras that were
offline (as of 2026-10-17 Jasa Marga's and BSD's streams answer empty or 404, also on BPJT's own
page). An operator BPJT names that is not yet in `TOLL_OPERATORS` is reported and left out until
its company name is added.

```bash
node scripts/build-cctv-roads.mjs --stations ../rutekita/assets/data/krl.json,../rutekita/assets/data/rail.json
```

## `facilities/`

What each KRL station has: exits, lifts, escalators, step-free access, toilets, musholla, parking and
ojol pick-up points. Built only from sources that allow reuse, by `scripts/build-facilities.mjs`.
Nothing is added by hand: a facility a source does not record is simply absent, and the app shows
"belum ada data" rather than a guess. To fix or add something, edit OpenStreetMap or the Wikipedia
article and rebuild.

The two sources stay in separate files because their licences cannot be merged into one database.

| File | Source | Licence | Holds |
|---|---|---|---|
| `osm.v1.json` | OpenStreetMap, via Overpass | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), © OpenStreetMap contributors | exits (name, ref and street only where OSM has them), lifts, escalators, toilets, musholla, car and motorcycle parking, pick-up points, the station's `wheelchair` tag |
| `wikipedia.v1.json` | Facility icons in each article's infobox, Wikipedia bahasa Indonesia | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.id), Kontributor Wikipedia | toilet, musholla, lift, escalator, accessible, parking, drop-off zone, plus the article title and revision they came from |

`osm.v1.json` is a derived database of OpenStreetMap and is offered under the ODbL;
`wikipedia.v1.json` is offered under CC BY-SA 4.0. Anyone showing them must credit the source the
same way.

OSM features count for a station when they lie on or within 15 m of the station's outline in OSM,
or when their own name names the station ("Shelter Ojek Online Sta. Depok Baru"). MRT/LRT features
and non-public entrances are left out. Every item keeps its OSM id (`node/123`) so it can be checked.

Not used: KAI Commuter's own pages (no reuse terms published, and the site blocks automated
access), Gojek/Grab pick-up lists (not open), and government open data (no station facility
dataset found as of 2026-10).

### Rebuilding

```bash
node scripts/build-facilities.mjs --stations ../rutekita/assets/data/krl.json --cache .cache
```

`--cache` keeps the raw Overpass and Wikipedia answers, so a rebuild from the same cache gives
the same files.

## Checking

Checks the CCTV catalog and both facility files; `--live` also requests every camera stream.

```bash
node scripts/check.mjs --live --stations ../rutekita/assets/data/krl.json,../rutekita/assets/data/rail.json
```
