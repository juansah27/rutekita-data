# rutekita-data

Data that the RuteKita app fetches at runtime, so it can change without an app release.

## `cctv/v1.json`

Public CCTV cameras at or near Jabodetabek rail stations (KRL, MRT, LRT), plus toll-road and city
road cameras.

- **Links only.** Video plays straight from each camera owner's server. Nothing here stores,
  records or re-streams video.
- **Official sources:** DJKA Kemenhub, Pemprov DKI Jakarta, Pemkot Bekasi, Pemkot Bogor,
  Dishub Kota Depok, Dishub Kabupaten Tangerang, DPUPR Kota Tangerang (SIPANTAU river posts and
  floodgates), Bina Marga Kementerian PU (national roads), the toll-road operators as listed by
  BPJT Kementerian PU, and Pemprov Banten.
- **One channel that is not a government's:** Pakuan Network's YouTube lives of Bogor's roads
  (cameras by Cemerlang CCTV and Padjajaran CCTV), played in YouTube's own embedded player.
- Each camera names its source and links its owner's page (`page`) for attribution. A toll camera's
  owner is its operator (badan usaha jalan tol); its page is BPJT's CCTV page.
- Camera owners who want a camera removed: open an issue and it will be taken out.

### Fields

| Field | Meaning |
|---|---|
| `station` | RuteKita station code, e.g. `MRI` (Manggarai) or `mrt:bundaran-hi`. Optional for `road` cameras: set only when one stands within 400 m of a station |
| `kind` | `station` = inside the station; `street` = public road next to it; `road` = a toll road or city road, not tied to a station |
| `area` | `road` only: the toll road or region the camera watches, e.g. `Tol JORR S` or `Pintu Air Kota Tangerang`; the app groups road cameras by it |
| `play.type` | `hls` = an `.m3u8` stream for the app's video player; `page` = the owner's player page, opened in a web view |
| `play.web` | `hls` only: `true` when the stream allows playback from other websites (CORS `*`). When `false`, the web version links to `page` instead |
| `lat`, `lon` | Where the owner publishes the camera's position, always both or neither. A `road` camera without them is listed under its `area` but has no marker on the map: positions are never guessed |

Bump `version` (and the file name) only for a change older apps cannot read. Adding cameras or
sources is not such a change, and neither is `road`: apps from before it skip those cameras, and
apps from before position-less road cameras skip only those.

### Road cameras

Every `road` camera is built, not hand-written. The builder reads BPJT's CCTV page
(https://bpjt.pu.go.id/cctv/), the Pemprov Banten list (https://cctv.bantenprov.go.id), Bina
Marga's national-road map (https://binamarga.pu.go.id/cctv-non-tol/), and the city lists of Dishub
Depok, Dishub Kabupaten Tangerang, Pemprov DKI and Pemkot Bekasi, and the river posts of SIPANTAU
(https://sipantau.dpuprkotang.info/) and Pakuan Network's YouTube lives
(https://www.youtube.com/@PakuanNetwork). It keeps the cameras inside
Jabodetabek whose stream is live right now, skips streams already hand-picked as station or street
cameras, and replaces every `road` camera in `cctv/v1.json`; the hand-picked cameras stay as
written. Live means more than a playlist: its newest segment must be video (some owners answer a
removed segment with their home page), it must not have ended (`#EXT-X-ENDLIST`, a short
recording), and it must move on within one and a half segments. A stream that starts only once it
is asked for (Dishub Depok) is given 25 s to start. `play.web` needs every step, playlists and
segments, to allow other websites, as the web player fetches them itself. It reports what it left
out per source and why. DKI and Bekasi publish no positions, so their cameras have none. SIPANTAU cameras play in
the owner's player page (`page`); their stream's playlist is only asked to see that they are up. A Pakuan Network live is taken when
YouTube says it is live now and may be embedded, under the place `PAKUAN_PLACES` gives its title;
a stream that restarts gets a new video, which the next build picks up. Pemkot Bogor's city list
is not built yet: its server did not answer on 2026-10-17. Run it again to pick up cameras that were
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
| `parking.v1.json` | OpenStreetMap, via Overpass | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), © OpenStreetMap contributors | car, motorcycle, bicycle and park-and-ride parking within 300 m of any boarding point, with the tags listed below |
| `wikipedia.v1.json` | Facility icons in each article's infobox, Wikipedia bahasa Indonesia | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/deed.id), Kontributor Wikipedia | toilet, musholla, lift, escalator, accessible, parking, drop-off zone, plus the article title and revision they came from |

`osm.v1.json` and `parking.v1.json` are derived databases of OpenStreetMap and are offered under the ODbL;
`wikipedia.v1.json` is offered under CC BY-SA 4.0. Anyone showing them must credit the source the
same way.

OSM features count for a station when they lie on or within 15 m of the station's outline in OSM,
or when their own name names the station ("Shelter Ojek Online Sta. Depok Baru"). MRT/LRT features
and non-public entrances are left out. Every item keeps its OSM id (`node/123`) so it can be checked.

### `parking.v1.json`

Parking a rider can use after riding a motorbike, bicycle or car to the stop: every OSM
`amenity=parking`, `amenity=motorcycle_parking`, `amenity=bicycle_parking` and `park_ride=*`
feature within **300 m in a straight line** (not walking distance along streets) of any boarding
point RuteKita knows: KRL stations, MRT and LRT stations, the KA Lokal / intercity stations, and
every TransJakarta halte and bus stop. The app has no airport-rail stations yet, so none are covered.

- One flat list, `parking`. A lot shared by several nearby stops is listed once; the app measures
  the distance from whichever stop the rider opened. `radius` is the 300 m the list was cut at.
- Each item: `osm` (`node/123`, `way/456`), `kind` (`car`, `motor`, `bicycle` or `park_ride`), `lat`/`lon`
  (a way's or relation's centre), and only the tags the feature has among `name`, `capacity`,
  `fee`, `charge`, `opening_hours`, `operator`, `access`, `covered`, `parking`, `building`,
  `motorcycle` and `park_ride`. A missing tag is missing in OSM; nothing is guessed.
- `kind` is `park_ride` whenever `park_ride` is set and not `no`; else `bicycle` or `motor` by amenity;
  an `amenity=parking` with `motorcar=no` counts as motorcycle parking only when it says
  `motorcycle=yes|designated`.
- Left out: `access=private`, `access=no` and `access=employees`. `customers`, `permit` and the like are
  kept with their `access` tag so the app can say so.

Not used: KAI Commuter's own pages (no reuse terms published, and the site blocks automated
access), Gojek/Grab pick-up lists (not open), and government open data (no station facility
dataset found as of 2026-10).

### Rebuilding

```bash
node scripts/build-facilities.mjs --stations ../rutekita/assets/data/krl.json \
  --stops ../rutekita/assets/data/rail.json,../rutekita/assets/data/intercity.json,../rutekita/assets/data/tj.json \
  --cache .cache
```

Add `--parking-only` to rebuild `parking.v1.json` alone. Without `--stops`, the parking list covers
the KRL stations only. `--cache` keeps the raw Overpass and Wikipedia answers, so a rebuild from the same cache gives
the same files.

## Checking

Checks the CCTV catalog and the facility files; `--live` also requests every camera stream.

```bash
node scripts/check.mjs --live --stations ../rutekita/assets/data/krl.json,../rutekita/assets/data/rail.json
```
