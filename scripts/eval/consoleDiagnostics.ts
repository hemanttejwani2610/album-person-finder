// Read-only console diagnostics for a Google Photos album page. Bundled by scripts/build.mjs into
// dist/console-diagnostics.js. Paste it into DevTools on the album grid: it runs the same adapter
// checks as the extension's Diagnostics panel (discovery + one scroll probe that scrolls back) and
// prints a redacted JSON report: counts, sizes, masked URL shapes, no photo ids or full URLs.
import { diagnoseDom, scrollProbe } from '../../src/content/domDiagnostics';

(async () => {
  const dom = diagnoseDom(document, location.href, window.devicePixelRatio);
  const scroll = dom.url.isAlbum ? await scrollProbe(document, location.href) : null;
  const report = { generatedBy: 'Album Person Finder console diagnostics', dom, scroll };
  console.log('[Album Person Finder] diagnostics report:\n' + JSON.stringify(report, null, 2));
})();
