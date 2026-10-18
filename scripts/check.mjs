// Validates cctv/v1.json and facilities/*.v1.json. Run before every commit:
//   node scripts/check.mjs                      shape only
//   node scripts/check.mjs --live               also request every stream
//   node scripts/check.mjs --stations krl.json,rail.json  also check station codes against RuteKita data
// Exit code 1 if any check fails.

import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const live = args.includes('--live');
const stationsArg = args.indexOf('--stations');
const stationsPath = stationsArg >= 0 ? args[stationsArg + 1] : null;

const KINDS = new Set(['station', 'street', 'road']);
const PLAY_TYPES = new Set(['hls', 'page']);
const errors = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);
const isHttps = (u) => typeof u === 'string' && u.startsWith('https://');

const catalog = JSON.parse(await readFile(new URL('../cctv/v1.json', import.meta.url), 'utf8'));
if (catalog.version !== 1) fail('catalog', `version ${catalog.version}, expected 1`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(catalog.updatedAt ?? '')) fail('catalog', 'updatedAt must be YYYY-MM-DD');

for (const [key, s] of Object.entries(catalog.sources ?? {})) {
  if (!s.name || !s.owner || !isHttps(s.page)) fail(`source ${key}`, 'needs name, owner and an https page');
}

const stationCodes = stationsPath
  ? new Set((await Promise.all(stationsPath.split(',').map(async (path) => JSON.parse(await readFile(path, 'utf8')).stations))).flat().map((s) => s.code))
  : null;

const ids = new Set();
for (const c of catalog.cameras ?? []) {
  const id = c.id ?? '(no id)';
  if (!/^[a-z0-9-]+$/.test(id)) fail(id, 'id must be lowercase letters, digits and dashes');
  if (ids.has(id)) fail(id, 'duplicate id');
  ids.add(id);
  if (!catalog.sources?.[c.source]) fail(id, `unknown source "${c.source}"`);
  if (!KINDS.has(c.kind)) fail(id, `kind must be one of ${[...KINDS].join(', ')}`);
  if (!c.name) fail(id, 'missing name');
  // A road camera names a station only when it stands next to one; the others need one.
  if (c.kind === 'road') {
    if (!c.area) fail(id, 'road camera needs an area');
  } else if (!c.station) fail(id, 'missing station');
  if (stationCodes && c.station !== undefined && !stationCodes.has(c.station)) fail(id, `unknown station code "${c.station}"`);
  if (!PLAY_TYPES.has(c.play?.type)) fail(id, `play.type must be one of ${[...PLAY_TYPES].join(', ')}`);
  if (!isHttps(c.play?.url)) fail(id, 'play.url must be https');
  if (c.play?.type === 'hls' && typeof c.play.web !== 'boolean') fail(id, 'hls play needs web: true|false');
  if (!isHttps(c.page)) fail(id, 'page must be https');
  if ((c.lat === undefined) !== (c.lon === undefined)) fail(id, 'lat and lon go together');
}

// Station facilities: two files, one per source, because their licences differ.
const OSM_LISTS = new Set(['exits', 'lifts', 'escalators', 'toilets', 'musholla', 'parkingCar', 'parkingMotor', 'pickup']);
const WIKI_FACILITIES = new Set(['toilet', 'musholla', 'lift', 'escalator', 'accessible', 'parking', 'dropoff']);
const ACCESS = new Set(['yes', 'limited', 'no']);
const isOsmRef = (r) => typeof r === 'string' && /^(node|way|relation)\/\d+$/.test(r);
const facilityCounts = [];
for (const file of ['osm', 'wikipedia']) {
  const data = JSON.parse(await readFile(new URL(`../facilities/${file}.v1.json`, import.meta.url), 'utf8'));
  const where = `facilities/${file}`;
  if (data.version !== 1) fail(where, `version ${data.version}, expected 1`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt ?? '')) fail(where, 'updatedAt must be YYYY-MM-DD');
  const src = data.source ?? {};
  if (!src.name || !src.attribution || !src.licence || !isHttps(src.licenceUrl) || !isHttps(src.page)) fail(where, 'source needs name, attribution, licence and https licenceUrl/page');
  for (const [code, e] of Object.entries(data.stations ?? {})) {
    const id = `${where} ${code}`;
    if (stationCodes && !stationCodes.has(code)) fail(id, 'unknown station code');
    if (file === 'osm') {
      for (const [key, v] of Object.entries(e)) {
        if (key === 'wheelchair') {
          if (!ACCESS.has(v?.value) || !isOsmRef(v?.osm)) fail(id, 'wheelchair needs value yes|limited|no and an osm ref');
        } else if (!OSM_LISTS.has(key)) fail(id, `unknown list "${key}"`);
        else if (!Array.isArray(v) || v.length === 0 || !v.every((item) => isOsmRef(item.osm))) fail(id, `${key} must be a non-empty list of items with an osm ref`);
      }
    } else {
      if (!e.article || !Number.isInteger(e.revision)) fail(id, 'needs article and revision');
      if (!Array.isArray(e.facilities) || e.facilities.length === 0 || !e.facilities.every((f) => WIKI_FACILITIES.has(f))) fail(id, 'facilities must be a non-empty list of known keys');
    }
  }
  facilityCounts.push(`${Object.keys(data.stations ?? {}).length} stations in ${where}`);
}

// Parking near boarding points: one list of OSM features, each kept once however many stops share it.
const PARKING_KINDS = new Set(['car', 'motor', 'bicycle', 'park_ride']);
const PARKING_TAGS = new Set(['name', 'capacity', 'fee', 'charge', 'opening_hours', 'operator', 'access', 'covered', 'parking', 'building', 'motorcycle', 'park_ride']);
{
  const where = 'facilities/parking';
  const data = JSON.parse(await readFile(new URL('../facilities/parking.v1.json', import.meta.url), 'utf8'));
  if (data.version !== 1) fail(where, `version ${data.version}, expected 1`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt ?? '')) fail(where, 'updatedAt must be YYYY-MM-DD');
  const src = data.source ?? {};
  if (!src.name || !src.attribution || !src.licence || !isHttps(src.licenceUrl) || !isHttps(src.page)) fail(where, 'source needs name, attribution, licence and https licenceUrl/page');
  if (!Number.isFinite(data.radius) || data.radius <= 0) fail(where, 'radius must be a positive number of metres');
  if (!Array.isArray(data.parking) || data.parking.length === 0) fail(where, 'parking must be a non-empty list');
  const seen = new Set();
  for (const p of data.parking ?? []) {
    const id = `${where} ${p.osm}`;
    if (!isOsmRef(p.osm)) fail(id, 'needs an osm ref');
    if (seen.has(p.osm)) fail(id, 'listed twice');
    seen.add(p.osm);
    if (!PARKING_KINDS.has(p.kind)) fail(id, `kind must be one of ${[...PARKING_KINDS].join(', ')}`);
    if (!(Math.abs(p.lat + 6.4) < 1 && Math.abs(p.lon - 106.75) < 1)) fail(id, 'lat/lon outside the Jabodetabek area');
    if (p.access === 'private' || p.access === 'no') fail(id, 'not public');
    for (const [k, v] of Object.entries(p)) {
      if (['osm', 'kind', 'lat', 'lon'].includes(k)) continue;
      if (!PARKING_TAGS.has(k)) fail(id, `unknown tag "${k}"`);
      else if (typeof v !== 'string' || !v.trim()) fail(id, `${k} must be non-empty text`);
    }
  }
  facilityCounts.push(`${seen.size} parking features in ${where}`);
}

// Some owners only answer CORS when the request names an origin, as a browser's does.
const WEB_ORIGIN = 'https://kaskitaserver.tail8f4ed4.ts.net';

if (live) {
  const results = await Promise.all(
    catalog.cameras.map(async (c) => {
      try {
        const res = await fetch(c.play.url, { headers: { origin: WEB_ORIGIN }, signal: AbortSignal.timeout(15000) });
        const type = res.headers.get('content-type') ?? '';
        const body = await res.text();
        const ok = res.ok && (c.play.type === 'page' ? type.includes('html') : body.startsWith('#EXTM3U'));
        const cors = res.headers.get('access-control-allow-origin');
        if (c.play.type === 'hls' && c.play.web && cors !== '*' && cors !== WEB_ORIGIN) fail(c.id, `web: true but CORS is "${cors}"`);
        return `${ok ? 'ok     ' : 'OFFLINE'} ${c.id}${ok ? '' : ` (${res.status} ${type})`}`;
      } catch (e) {
        return `OFFLINE ${c.id} (${e.name})`;
      }
    }),
  );
  console.log(results.join('\n'));
  // Cameras go offline for a while; report them but do not fail the run.
}

console.log(`${catalog.cameras.length} cameras, ${Object.keys(catalog.sources).length} sources, ${facilityCounts.join(', ')}, ${errors.length} errors`);
for (const e of errors) console.log('  ' + e);
process.exit(errors.length ? 1 : 0);
