// Release build + Chrome Web Store ZIP: album-person-finder-<version>.zip in the project root,
// with manifest.json at the top level and no source maps.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
execFileSync('node', [path.join(root, 'scripts/build.mjs'), '--release'], { stdio: 'inherit' });

const dist = path.join(root, 'dist');
const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== version) throw new Error(`manifest version ${manifest.version} != package.json ${version}`);

const zipPath = path.join(root, `album-person-finder-${version}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);
// -X: no extra file attributes; exclude macOS metadata and any source maps.
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', '*.map', '-x', '.DS_Store', '-x', '*/.DS_Store'], { cwd: dist, stdio: 'inherit' });
console.log(`Packaged ${path.basename(zipPath)} (${(statSync(zipPath).size / 1e6).toFixed(1)} MB) for upload to the Chrome Web Store.`);
