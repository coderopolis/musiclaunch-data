// ---------------------------------------------------------------------------
// Output guard for the quarterly resource updaters.
//
// The AI phase can (and on 2026-07-01 did) produce entries the app cannot use:
//   • re-adding services removed on purpose (That Pitch, Vampr came back)
//   • categories the app doesn't know — the app only renders entries whose
//     category is one of its own keys, so 24 of 45 sync listings silently
//     disappeared from the Sync Licensing → Resources page.
// Every script runs its output through sanitize() before writing the file.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const EXCLUDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'excluded-services.json'), 'utf-8')
).excluded;

function host(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The exclusion entry that matches this resource, if any. */
function excludedMatch(resource) {
  const name = String(resource.name || '').trim().toLowerCase();
  const h = host(resource.url);
  return EXCLUDED.find(
    (x) =>
      x.name.toLowerCase() === name ||
      (h && x.domains.some((d) => h === d || h.endsWith('.' + d)))
  );
}

/** One line per excluded service, for the model's instructions. */
function exclusionPromptLines() {
  return EXCLUDED.map((x) => `- ${x.name}${x.domains.length ? ` (${x.domains.join(', ')})` : ''}`).join('\n');
}

/**
 * Drop excluded services; repair or drop entries with unknown categories.
 * Returns { resources, log } — never throws on content, only on bad input.
 */
function sanitize(updatedResources, currentResources, validCategories) {
  const valid = new Set(validCategories);
  const previous = new Map(currentResources.map((r) => [String(r.name).toLowerCase(), r]));
  const log = [];
  const resources = [];
  for (const r of updatedResources) {
    const hit = excludedMatch(r);
    if (hit) {
      log.push(`excluded: ${r.name} (${hit.reason})`);
      continue;
    }
    if (!valid.has(r.category)) {
      const prev = previous.get(String(r.name).toLowerCase());
      if (prev && valid.has(prev.category)) {
        log.push(`category restored: ${r.name} "${r.category}" → "${prev.category}"`);
        resources.push({ ...r, category: prev.category });
      } else {
        log.push(`dropped (unknown category "${r.category}"): ${r.name}`);
      }
      continue;
    }
    resources.push(r);
  }
  return { resources, log };
}

module.exports = { sanitize, exclusionPromptLines, excludedMatch };
