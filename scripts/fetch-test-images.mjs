// Downloads the public-domain test photos used by the browser smoke test and model evaluation
// (NASA photos on Wikimedia Commons, all marked "Public domain"). Test data only: never bundled
// into the extension.
//
// Usage: node scripts/fetch-test-images.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('Usage: node scripts/fetch-test-images.mjs <outDir>');
  process.exit(2);
}

// Role prefixes: ref_ = reference (Kate Rubins), pos_ = contains her, neg_ = other people only, noface_ = no people.
export const TEST_IMAGES = {
  'ref_rubins.jpg': 'Kathleen Rubins portrait.jpg',
  'pos_exp49_group.jpg': 'Expedition 49 crew portrait with astronaut Kate Rubins, cosmonaut Anatoly Ivanishin, and astronaut Takuya Onishi.jpg',
  'pos_exp49_crew2.jpg': 'Expedition 49 crew portrait.jpg',
  'pos_exp64_group.jpg': 'Expedition 64 crew portrait.jpg',
  'pos_soyuz_group.jpg': 'Soyuz MS-01 official crew portrait.jpg',
  'pos_destiny.jpg': 'ISS-48 Kate Rubins in the Destiny lab.jpg',
  'pos_beam.jpg': 'ISS-48 Kate Rubins inside the BEAM.jpg',
  'neg_meir.jpg': 'Jessica Meir (portrait crop).jpg',
  'neg_meir2.jpg': 'Portrait - Astronaut Jessica Meir (NHQ202009150005).jpg',
  'neg_koch.jpg': 'Christina M. Hammock portrait.jpg',
  'neg_exp61_group.jpg': 'Expedition 61 crew portrait.jpg',
  'neg_spacewalk_group.jpg': 'ISS Expedition 61 crew before first all-female spacewalk in history – 2019-10-18.jpg',
  'noface_iss.jpg': 'International Space Station after undocking of STS-132.jpg',
};

mkdirSync(outDir, { recursive: true });
for (const [local, title] of Object.entries(TEST_IMAGES)) {
  const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}?width=1280`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AlbumPersonFinder-tests/0.1 (local test data)' } });
  if (!res.ok) throw new Error(`${title}: HTTP ${res.status}`);
  writeFileSync(path.join(outDir, local), Buffer.from(await res.arrayBuffer()));
  console.log(`ok  ${local}  ←  File:${title}`);
}
