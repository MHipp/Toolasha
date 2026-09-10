/**
 * The "shipped in" markers, and what they let the panel show.
 *
 * The what's-new panel wants to answer "what changed since the build I was
 * running". The changelog cannot answer that on its own: the fork's
 * `## Unreleased — branch \`main\`` heading is never rotated, so every entry
 * since the fork diverged lives under one heading with nothing in the text to
 * say where one release ended and the next began.
 *
 * So a release stamps a marker — an HTML comment, invisible in rendered
 * markdown on GitHub — directly under that heading before it merges
 * (`scripts/stamp-changelog-version.js`). Entries are newest-first, so a marker
 * means "everything below me had shipped by then", and the entries above the
 * marker for *your* version are exactly the ones you have not seen.
 *
 * The split between build and run matters. The slice runs at build time and
 * cannot know which version any given player last ran, so it ships the newest
 * entries **with their markers intact** and the filtering happens here, at run
 * time, against the version the popup already stores.
 *
 * Everything here is pure, and every path ends in output with the markers
 * removed: they are data for this module, never text for a player to read.
 */

import { compareVersions } from '../../utils/compare-versions.js';

/** One stamped release boundary. Kept loose on the version so `3.47` parses. */
const MARKER_RE = /^<!--\s*shipped in\s+(\d+(?:\.\d+)*)\s*-->\s*$/;

/**
 * Format the marker a release stamps into the changelog.
 * @param {string} version - The version being released, e.g. `3.47.0`
 * @returns {string} e.g. `<!-- shipped in 3.47.0 -->`
 */
export function markerFor(version) {
    return `<!-- shipped in ${version} -->`;
}

/**
 * Read a line as a marker.
 * @param {string} line - One line of the changelog
 * @returns {string|null} The version it marks, or null when it is not a marker
 */
export function markerVersion(line) {
    const match = MARKER_RE.exec(String(line));
    return match ? match[1] : null;
}

/**
 * Every marker in a piece of changelog, in document order (newest first).
 * @param {string} text - Changelog markdown
 * @returns {Array<string>} The versions marked
 */
export function markerVersions(text) {
    return String(text ?? '')
        .split('\n')
        .map(markerVersion)
        .filter(Boolean);
}

/**
 * Drop every marker line, and the blank line each one leaves behind.
 * @param {string} text - Changelog markdown
 * @returns {string} The same markdown with no markers in it
 */
export function stripMarkers(text) {
    return String(text ?? '')
        .split('\n')
        .filter((line) => markerVersion(line) === null)
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * @typedef {object} FilteredChangelog
 * @property {string} text - Markdown to show, always marker-free
 * @property {boolean} filtered - Whether anything was held back as already-seen
 * @property {number} totalEntries - `###` entries in the shipped text
 * @property {number} shownEntries - How many of them survived
 */

/**
 * The entries newer than the build the player was running.
 *
 * Falls back to the whole shipped slice — the panel's behaviour today —
 * whenever it cannot do better, which is most of the interesting cases:
 *
 * - **No markers.** True for every build until the first marked release
 *   merges, and true forever for anyone reading a hand-built changelog. There
 *   is nothing to cut on, so nothing is cut.
 * - **No stored version.** A first run has no "before" to be newer than.
 * - **Older than everything shipped.** The slice is already bounded, so the
 *   oldest marker may still be newer than the player's build; all of it is new
 *   to them, and the slice's own "N earlier changes are not shown" line — which
 *   rides along at the end of the last entry — stays, because it is still true.
 * - **Nothing newer.** A rebuild at the same version with no entries above its
 *   marker would leave an empty box under an "Updated x → y" heading, which
 *   says less than showing the recent history does.
 *
 * The remaining case is the one this exists for: the player's version has a
 * marker, and there are entries above it. Those entries ship; the rest do not.
 * Entries above the newest marker are the not-yet-released ones — they are
 * above every marker, so they are always kept.
 * @param {string} text - The shipped slice, markers and all
 * @param {string|null} [sinceVersion] - The version the player last ran
 * @returns {FilteredChangelog}
 */
export function filterChangelogSince(text, sinceVersion) {
    const source = String(text ?? '');
    const lines = source.split('\n');
    const entryStarts = [];
    const markers = [];
    for (let i = 0; i < lines.length; i++) {
        const version = markerVersion(lines[i]);
        if (version) markers.push({ version, line: i });
        else if (/^###\s/.test(lines[i])) entryStarts.push(i);
    }

    const all = () => ({
        text: stripMarkers(source),
        filtered: false,
        totalEntries: entryStarts.length,
        shownEntries: entryStarts.length,
    });

    if (!sinceVersion || markers.length === 0 || entryStarts.length === 0) return all();

    // The newest release the player already had. Markers run newest-first, but
    // pick by comparison rather than by position so a hand-edited changelog
    // cannot invert the answer.
    let baseline = null;
    for (const marker of markers) {
        if (compareVersions(marker.version, sinceVersion) > 0) continue;
        if (!baseline || compareVersions(marker.version, baseline.version) > 0) baseline = marker;
    }
    if (!baseline) return all(); // Older than everything shipped: all of it is new

    const shownEntries = entryStarts.filter((start) => start < baseline.line).length;
    if (shownEntries === 0) return all(); // Nothing newer than their build
    if (shownEntries === entryStarts.length) return all(); // Nothing to hold back

    const kept = lines.slice(0, entryStarts[shownEntries]);
    return {
        text: `${stripMarkers(kept.join('\n')).replace(/\s+$/, '')}\n`,
        filtered: true,
        totalEntries: entryStarts.length,
        shownEntries,
    };
}
