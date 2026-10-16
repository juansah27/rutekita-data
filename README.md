# rutekita-data

Data that the RuteKita app fetches at runtime, so it can change without an app release.

## `cctv/v1.json`

Public CCTV cameras at or near KRL Jabodetabek stations.

- **Links only.** Video plays straight from each camera owner's server. Nothing here stores,
  records or re-streams video.
- **Official sources only:** DJKA Kemenhub, Pemprov DKI Jakarta, Pemkot Bekasi, Pemkot Bogor and
  Dishub Kota Depok. Each camera names its source and links its owner's page (`page`) for
  attribution.
- Camera owners who want a camera removed: open an issue and it will be taken out.

### Fields

| Field | Meaning |
|---|---|
| `station` | RuteKita station code, e.g. `MRI` (Manggarai) |
| `kind` | `station` = inside the station; `street` = public road next to it |
| `play.type` | `hls` = an `.m3u8` stream for the app's video player; `page` = the owner's player page, opened in a web view |
| `play.web` | `hls` only: `true` when the stream allows playback from other websites (CORS `*`). When `false`, the web version links to `page` instead |
| `lat`, `lon` | Optional; only where the owner publishes the camera's position |

Bump `version` (and the file name) only for a change older apps cannot read. Adding cameras or
sources is not such a change.

### Checking

```bash
node scripts/check.mjs --live --stations ../rutekita/assets/data/krl.json
```
