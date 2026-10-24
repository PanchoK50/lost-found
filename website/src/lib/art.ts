import { readdir } from 'node:fs/promises';
import path from 'node:path';

// Server-only: which generated art files exist (tools/art/ writes them into public/art/).
const ART_DIR = path.join(process.cwd(), 'public', 'art');

async function names(folder: string, extension: string): Promise<string[]> {
  try {
    return (await readdir(path.join(ART_DIR, folder))).filter(file => file.endsWith(extension)).map(file => file.slice(0, -extension.length));
  } catch {
    return [];
  }
}

export interface ArtManifest { icons: string[]; textures: string[]; models: string[] }

export async function listArt(): Promise<ArtManifest> {
  const [icons, textures, models] = await Promise.all([names('icons', '.png'), names('textures', '.jpg'), names('models', '.glb')]);
  return { icons, textures, models };
}
