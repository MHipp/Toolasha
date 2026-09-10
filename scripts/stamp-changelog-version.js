#!/usr/bin/env node

/**
 * Stamp a release boundary into the fork changelog.
 *
 * The fork's `## Unreleased — branch \`main\`` heading is never rotated, so
 * every entry since the fork diverged sits under it with nothing to say where
 * one release ended and the next began. The what's-new panel wants exactly that
 * boundary, so a release writes one: an HTML comment directly under the
 * heading, above the newest entry. Entries are newest-first, so it reads as
 * "everything below me shipped in this version", and everything written after
 * it lands above it.
 *
 * An HTML comment because GitHub renders the changelog and nobody reading it
 * should see this; the panel strips markers from what it shows for the same
 * reason (`src/features/settings/changelog-markers.js`).
 *
 * ## Why here and not in `sync-version.js`
 *
 * `sync-version.js` propagates `package.json`'s version into the places that
 * merely *state* it — headers, the README badge, `entrypoint.js`. Re-running it
 * anywhere, at any time, converges on the same files. Stamping is not that: it
 * appends to a history, it is meaningful only once per release, and it must not
 * happen on a developer's machine just because they ran `npm run version:sync`
 * to fix a header. Different job, different lifetime, its own script — and it
 * runs as its own step in `.github/workflows/format-release-please.yml`, where
 * the checked-out branch is release-please's, whose `package.json` already
 * carries the version about to be released.
 *
 * ## Idempotency
 *
 * That workflow re-runs on every push to the release PR, including the bot's
 * force-pushes and the workflow's own commit. Stamping twice must not produce
 * two markers for one release, so a version already marked anywhere in the
 * section is left alone and the script exits reporting no change.
 *
 * Usage:
 *   node scripts/stamp-changelog-version.js            # version from package.json
 *   node scripts/stamp-changelog-version.js 3.48.0     # or state it
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** The heading the marker goes under — the fork's never-rotated section. */
const UNRELEASED_RE = /^## Unreleased\b.*$/m;

/**
 * Format the marker for a version. Must match the reader in
 * `src/features/settings/changelog-markers.js`.
 * @param {string} version - e.g. `3.48.0`
 * @returns {string} e.g. `<!-- shipped in 3.48.0 -->`
 */
export function markerFor(version) {
    return `<!-- shipped in ${version} -->`;
}

/**
 * Whether this version has already been stamped.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @param {string} version - The version to look for
 * @returns {boolean}
 */
export function hasMarker(changelog, version) {
    return String(changelog ?? '')
        .split('\n')
        .some((line) => {
            const match = /^<!--\s*shipped in\s+(\d+(?:\.\d+)*)\s*-->\s*$/.exec(line);
            return Boolean(match) && match[1] === String(version);
        });
}

/**
 * Insert the marker directly under the unreleased heading.
 *
 * Returns the changelog unchanged — and says so — when the version is already
 * marked, or when there is no unreleased heading to stamp under. Neither is an
 * error: the first is the workflow running twice, and the second is a changelog
 * shaped differently from the one this was written for, where silently doing
 * nothing beats guessing at a place to write.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @param {string} version - The version being released
 * @returns {{text: string, changed: boolean, reason: string}}
 */
export function stampChangelog(changelog, version) {
    const text = String(changelog ?? '');
    if (!/^\d+(\.\d+)*$/.test(String(version ?? ''))) {
        return { text, changed: false, reason: `not a version: ${version}` };
    }
    if (hasMarker(text, version)) return { text, changed: false, reason: `already marked ${version}` };

    const heading = UNRELEASED_RE.exec(text);
    if (!heading) return { text, changed: false, reason: 'no "## Unreleased" heading' };

    const at = heading.index + heading[0].length;
    return {
        text: `${text.slice(0, at)}\n\n${markerFor(version)}${text.slice(at)}`,
        changed: true,
        reason: `marked ${version}`,
    };
}

/* c8 ignore start -- the CLI wrapper; the decisions above are what is tested */
function main() {
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const version = process.argv[2] || JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
    const path = join(rootDir, 'CHANGELOG.md');
    const result = stampChangelog(readFileSync(path, 'utf8'), version);
    if (result.changed) {
        writeFileSync(path, result.text, 'utf8');
        console.log(`✅ CHANGELOG.md ${result.reason}`);
    } else {
        console.log(`ℹ️  CHANGELOG.md unchanged (${result.reason})`);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
/* c8 ignore stop */
