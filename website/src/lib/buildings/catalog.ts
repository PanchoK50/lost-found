import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Building, CatalogEntry } from './types';

// Server-only: reads the challenge dataset from the repo's data/ folder (website/../data by default).
const DATA_DIR = process.env.BUILDINGS_DATA_DIR ?? path.join(process.cwd(), '..', 'data');

type Row = { entry: CatalogEntry; path: string };
let manifest: Promise<Map<string, Row>> | undefined;

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadManifest(): Promise<Map<string, Row>> {
  const [header, ...rows] = parseCsv(await readFile(path.join(DATA_DIR, 'manifest.csv'), 'utf8'));
  const col = (name: string) => header.indexOf(name);
  return new Map(rows.map(cells => {
    const get = (name: string) => cells[col(name)] ?? '';
    const entry: CatalogEntry = {
      id: get('building_id'),
      split: get('split') as CatalogEntry['split'],
      source: get('source'),
      name: get('name'),
      floors: Number(get('floors')),
      levels: get('levels').split(';').map(Number),
      rooms: Number(get('rooms')),
      assets: Number(get('assets')),
      hasLift: get('has_lift') === 'True',
    };
    return [entry.id, { entry, path: get('path') }];
  }));
}

function getManifest() {
  manifest ??= loadManifest().catch(error => { manifest = undefined; throw error; });
  return manifest;
}

export async function listBuildings(): Promise<CatalogEntry[]> {
  return [...(await getManifest()).values()].map(row => row.entry);
}

/** Directory of a known building, or null. Ids are only ever looked up, never joined into paths directly. */
export async function buildingDir(id: string): Promise<string | null> {
  const row = (await getManifest()).get(id);
  return row ? path.join(DATA_DIR, row.path) : null;
}

export async function loadBuilding(id: string): Promise<Building | null> {
  const dir = await buildingDir(id);
  return dir ? JSON.parse(await readFile(path.join(dir, 'building.json'), 'utf8')) : null;
}
