// Downloads the benchmark photos listed in manifest.json (1,280 px wide) into <outDir>.
// Usage: node scripts/benchmark/fetch.mjs <outDir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2];
if (!outDir) throw new Error('Usage: node scripts/benchmark/fetch.mjs <outDir>');
const { photos } = JSON.parse(readFileSync(path.join(here, 'manifest.json'), 'utf8'));
mkdirSync(outDir, { recursive: true });
for (const [i, p] of photos.entries()) {
  const dest = path.join(outDir, `${String(i).padStart(3, '0')}.jpg`);
  if (existsSync(dest)) continue;
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(p.file)}?width=1280`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AlbumPersonFinder-benchmark/0.1 (local test data)' } });
  if (!res.ok) throw new Error(`${p.file}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`ok ${dest}  ${p.file}`);
}
