// Validates cctv/v1.json. Run before every commit:
//   node scripts/check.mjs                      shape only
//   node scripts/check.mjs --live               also request every stream
//   node scripts/check.mjs --stations krl.json  also check station codes against RuteKita data
// Exit code 1 if any check fails.

import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const live = args.includes('--live');
const stationsArg = args.indexOf('--stations');
const stationsPath = stationsArg >= 0 ? args[stationsArg + 1] : null;

const KINDS = new Set(['station', 'street']);
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
  ? new Set(JSON.parse(await readFile(stationsPath, 'utf8')).stations.map((s) => s.code))
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
  if (stationCodes && !stationCodes.has(c.station)) fail(id, `unknown station code "${c.station}"`);
  if (!PLAY_TYPES.has(c.play?.type)) fail(id, `play.type must be one of ${[...PLAY_TYPES].join(', ')}`);
  if (!isHttps(c.play?.url)) fail(id, 'play.url must be https');
  if (c.play?.type === 'hls' && typeof c.play.web !== 'boolean') fail(id, 'hls play needs web: true|false');
  if (!isHttps(c.page)) fail(id, 'page must be https');
  if ((c.lat === undefined) !== (c.lon === undefined)) fail(id, 'lat and lon go together');
}

if (live) {
  const results = await Promise.all(
    catalog.cameras.map(async (c) => {
      try {
        const res = await fetch(c.play.url, { signal: AbortSignal.timeout(15000) });
        const type = res.headers.get('content-type') ?? '';
        const body = await res.text();
        const ok = res.ok && (c.play.type === 'page' ? type.includes('html') : body.startsWith('#EXTM3U'));
        const cors = res.headers.get('access-control-allow-origin');
        if (c.play.type === 'hls' && c.play.web && cors !== '*') fail(c.id, `web: true but CORS is "${cors}"`);
        return `${ok ? 'ok     ' : 'OFFLINE'} ${c.id}${ok ? '' : ` (${res.status} ${type})`}`;
      } catch (e) {
        return `OFFLINE ${c.id} (${e.name})`;
      }
    }),
  );
  console.log(results.join('\n'));
  // Cameras go offline for a while; report them but do not fail the run.
}

console.log(`${catalog.cameras.length} cameras, ${Object.keys(catalog.sources).length} sources, ${errors.length} errors`);
for (const e of errors) console.log('  ' + e);
process.exit(errors.length ? 1 : 0);
