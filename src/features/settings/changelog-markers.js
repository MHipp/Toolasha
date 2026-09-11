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
 * cannot know which version any given player last ran, so it ships enough
 * entries to cover the last few releases **with their markers intact**
 * (`scripts/changelog-slice.js`) and the filtering happens here, at run time,
 * against the version the popup already stores.
 *
 * Everything here is pure, and every path ends in output with the markers
 * removed: they are data for this module, never text for a player to read.
 */

import { compareVersions } from '../../utils/compare-versions.js';

/** One stamped release boundary. Kept loose on the version so `3.47` parses. */
const MARKER_RE = /^<!--\s*shipped in\s+(\d+(?:\.\d+)*)\s*-->\s*$/;

/**
 * The line the slice appends when entries did not fit, as written by
 * `omissionNote` in `scripts/changelog-slice.js`.
 *
 * Matched loosely — the count and the sentence's opening are the load-bearing
 * parts — so that a reworded tail there cannot leave two omission lines here.
 * Like `MARKER_RE`, a deliberate copy rather than an import: build tooling and
 * bundle code share a sentence shape, not a module.
 */
const OMISSION_RE = /^(?:(\d+)|One) more changes? (?:are|is) not shown here[^\n]*$/m;

/**
 * Format the marker a release stamps into the changelog.
 * @param {string} version - The version being released, e.g. `3.47.0`
 * @returns {string} e.g. `<!-- shipped in 3.47.0 -->`
 */
export function markerFor(version) {
    return `<!-- shipped in ${version} -->`;
}

/**
 * The omission line, in the two flavours it has.
 *
 * "Earlier changes" was the old wording and it was wrong in the case that
 * matters most: when the slice does not reach back as far as the player's
 * build, some of what it left out is *newer* than that build, not older. So
 * the neutral wording — what the build writes, since the build does not know
 * who is reading — says only that there are more; and when the panel can see
 * that the player is further back than the slice reaches, it says so, because
 * "some of these are from after your last update" and "these are ancient
 * history" are different facts and a player acts on them differently.
 * @param {number} count - How many entries were left out
 * @param {object} [options]
 * @param {boolean} [options.sinceUpdate] - Whether some of them are known to be
 *   newer than the build the player was running
 * @returns {string} One markdown paragraph
 */
export function omissionLine(count, options = {}) {
    const subject = count === 1 ? 'One more change is' : `${count} more changes are`;
    let qualifier = '';
    if (options.sinceUpdate) {
        qualifier =
            count === 1 ? ', and it is newer than your last update' : ', some of them newer than your last update';
    }
    return `${subject} not shown here${qualifier} — the full list is in CHANGELOG.md on GitHub.`;
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
 * Say, in the omission line, that some of what was left out is new to this
 * player. A no-op when the slice left nothing out and so wrote no line.
 * @param {string} text - The shipped slice
 * @returns {string} The same markdown, with the line reworded if there is one
 */
function noteOmissionsAreRecent(text) {
    return text.replace(OMISSION_RE, (line, count) => omissionLine(Number(count ?? 1), { sinceUpdate: true }));
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
 *   is nothing to cut on, so nothing is cut, and nothing is reworded either.
 * - **No stored version.** A first run has no "before" to be newer than.
 * - **Older than everything shipped.** The slice reaches back a few releases,
 *   not forever, so a player who has been away longer than that has no marker
 *   of their own in it. All of it is new to them — and so is some of what the
 *   slice left out, which is why the omission line is reworded to say so
 *   rather than calling those entries "earlier".
 * - **Nothing newer.** A rebuild at the same version with no entries above its
 *   marker would leave an empty box under an "Updated x → y" heading, which
 *   says less than showing the recent history does.
 *
 * The remaining case is the one this exists for: the player's version has a
 * marker, and there are entries above it. Those entries ship; the rest do not.
 * Entries above the newest marker are the not-yet-released ones — they are
 * above every marker, so they are always kept. The omission line goes with the
 * entries it was talking about: everything since their build is on screen, so
 * a count of older history is noise.
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

    const all = (body = source) => ({
        text: stripMarkers(body),
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
    // Older than everything shipped: all of it is new, and so is at least the
    // release the oldest marker names, whose entries the slice did not carry.
    if (!baseline) return all(noteOmissionsAreRecent(source));

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
