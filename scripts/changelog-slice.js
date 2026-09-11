/**
 * Pick the slice of the fork changelog that ships inside the bundle.
 *
 * The what's-new popup shows what changed since the last update, and
 * `CHANGELOG.md` is where that is already written — so the build embeds a piece
 * of it as a virtual module (see `changelogPlugin` in `rollup.config.js`).
 *
 * The piece has to be chosen carefully. The fork's `## Unreleased — branch
 * main` heading is never rotated: release-please manages the `## [x.y.z]`
 * sections *below* it, and nothing ever moves entries out of the unreleased
 * body, so it holds every change since the fork diverged — hundreds of entries
 * and hundreds of kilobytes. Embedding a fixed number of *characters* of that
 * cuts mid-sentence and still shows many releases' worth of history under a
 * heading that claims one release.
 *
 * So the slice is counted in entries, not characters: whole `###` entries, as
 * many as it takes to cover the last {@link DEFAULT_RELEASES_BACK} releases,
 * with caps on both entries and characters kept as backstops. When entries are
 * left out the slice says so in one line, so the panel ends deliberately rather
 * than just stopping.
 *
 * Release boundaries are what makes "as many as it takes" answerable. A release
 * stamps `<!-- shipped in x.y.z -->` under the unreleased heading
 * (`scripts/stamp-changelog-version.js`), so the markers say where each release
 * began and the slice can ship down to the one that serves a player some number
 * of releases behind. The markers ride along in what ships, because the panel
 * narrows the slice again at run time to the entries newer than the build the
 * player was running — a question the build cannot answer, since it does not
 * know who is asking. Markers are comments: they are not entries, they do not
 * count against the entry cap, and the panel strips them before drawing.
 *
 * This lives outside `rollup.config.js` so it can be tested directly: it is the
 * only part of the plugin with any judgement in it.
 */

/**
 * How many releases back the slice tries to serve.
 *
 * Marker semantics decide the arithmetic: the marker for a version sits *above*
 * the entries that shipped in it, so serving a player who last ran version V
 * means shipping every entry above V's marker, and V's marker with them. Two
 * releases back is therefore the marker at index 2, counting the release being
 * built as 0 — it covers the player who updated normally and the player who
 * skipped one.
 *
 * Why two and not more: over the last 29 releases the fork shipped a median of
 * 8 entries per release, a 90th percentile of 26 and a worst case of 35, at
 * roughly one release a day. Two releases is a median of 23 entries (~19 KB)
 * and a 90th percentile of 42; three is a median of 35 and a 90th percentile of
 * 59, which the caps below would cut most of the time — bundle weight without
 * coverage to show for it. Someone further behind than this still sees the
 * whole slice, with the omission line saying that there is more.
 */
export const DEFAULT_RELEASES_BACK = 2;

/**
 * The floor, and the answer when there is nothing better.
 *
 * Also exactly what the slice shipped before it could read markers, which is
 * the point: an unmarked changelog — every build until the first marked release
 * merges, and any hand-built one after that — has no release boundary to slice
 * on and falls back to this, unchanged. It doubles as the minimum for a quiet
 * release, so two one-line releases in a row cannot leave a player who is
 * further behind staring at a two-item list.
 */
export const DEFAULT_MIN_ENTRIES = 12;

/**
 * The entry cap. A backstop, not the primary limit — the release boundary is —
 * but one release genuinely ran to 35 entries and nothing stops the next from
 * running to fifty, and neither the bundle nor the reader wants all of them.
 */
export const DEFAULT_MAX_ENTRIES = 30;

/**
 * The character cap. Entries are prose whose length nobody enforces, so the
 * entry cap alone does not bound bytes. Entries are dropped whole to stay under
 * it. Thirty recent entries run about 10 KB; this leaves room for wordier ones
 * without letting a long-winded release balloon the bundle.
 */
export const DEFAULT_MAX_CHARS = 24000;

/**
 * Cut the first `## Unreleased` section out of a changelog.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @returns {string} The section including its heading, or '' when there is none
 */
export function extractUnreleasedSection(changelog) {
    const text = String(changelog ?? '');
    const start = text.search(/^## Unreleased/m);
    if (start === -1) return '';
    const rest = text.slice(start);
    // Skip past the heading's own `## ` before looking for the next one.
    const end = rest.slice(3).search(/^## /m);
    return end === -1 ? rest : rest.slice(0, end + 3);
}

/**
 * One stamped release boundary.
 *
 * Deliberately a copy of the reader in
 * `src/features/settings/changelog-markers.js` rather than an import of it:
 * this is build tooling and that is bundle code, and the shared thing is a
 * one-line comment format written down in both places.
 */
const MARKER_RE = /^<!--\s*shipped in\s+(\d+(?:\.\d+)*)\s*-->\s*$/;

/**
 * Release boundaries present in a piece of changelog, in document order.
 * @param {string} text - Changelog markdown
 * @returns {Array<string>} The versions marked, newest first
 */
function markerVersionsIn(text) {
    return String(text ?? '')
        .split('\n')
        .map((line) => MARKER_RE.exec(line))
        .filter(Boolean)
        .map((match) => match[1]);
}

/**
 * The one line the panel shows in place of everything that did not fit.
 *
 * Deliberately neutral about *when* the missing entries happened. The build
 * cannot know: "earlier changes" is only true for a player the slice reaches
 * back to, and the player it does not reach is exactly the one whose missing
 * entries are recent. The panel sharpens the wording at run time when it can
 * tell (`omissionLine` in `changelog-markers.js`) — the same sentence shape, so
 * it can find this line and rewrite it.
 * @param {number} omitted - How many entries were left out
 * @returns {string} A markdown paragraph
 */
function omissionNote(omitted) {
    const subject = omitted === 1 ? 'One more change is' : `${omitted} more changes are`;
    return `${subject} not shown here — the full list is in CHANGELOG.md on GitHub.`;
}

/**
 * @typedef {object} ChangelogSlice
 * @property {string} text - The markdown to embed
 * @property {number} totalEntries - `###` entries in the unreleased section
 * @property {number} shownEntries - How many of them the slice keeps
 * @property {number} omittedEntries - How many it leaves out
 * @property {Array<string>} markerVersions - Release boundaries in the slice,
 *   newest first — what the runtime filter has to work with
 */

/**
 * How many entries it takes to cover `releasesBack` releases.
 *
 * The marker for a version sits above that version's entries, so the entries
 * above marker number `releasesBack` are everything a player that far behind
 * has not seen — and keeping them keeps that marker too, since it sits at the
 * tail of the last entry kept, which is what lets the runtime filter recognise
 * the player's build. Fewer markers than asked for means shipping to the oldest
 * one there is; none at all means there is nothing to answer with.
 * @param {Array<number>} entryStarts - Line numbers of the `###` entries
 * @param {Array<number>} markerLines - Line numbers of the markers, in order
 * @param {number} releasesBack - How many releases back to cover
 * @returns {number} Entries needed, 0 when no marker can say
 */
function entriesToCover(entryStarts, markerLines, releasesBack) {
    if (markerLines.length === 0) return 0;
    const target = markerLines[Math.min(Math.max(0, releasesBack), markerLines.length - 1)];
    return entryStarts.filter((start) => start < target).length;
}

/**
 * Choose what the what's-new popup ships.
 *
 * Keeps the newest entries whole — an entry that would not fit under the
 * character cap is dropped entirely rather than truncated, because a
 * half-sentence is worse than a missing one — and appends a line naming how many
 * were left out. A section already inside every limit comes back unchanged.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @param {object} [options]
 * @param {number} [options.releasesBack] - Releases to cover, the primary limit
 * @param {number} [options.minEntries] - Floor, and the unmarked fallback
 * @param {number} [options.maxEntries] - Entry cap, a backstop
 * @param {number} [options.maxChars] - Character cap, a backstop
 * @returns {ChangelogSlice}
 */
export function sliceForkChangelog(changelog, options = {}) {
    const releasesBack = options.releasesBack ?? DEFAULT_RELEASES_BACK;
    const minEntries = options.minEntries ?? DEFAULT_MIN_ENTRIES;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const section = extractUnreleasedSection(changelog);
    if (!section.trim()) return { text: '', totalEntries: 0, shownEntries: 0, omittedEntries: 0, markerVersions: [] };

    const lines = section.split('\n');
    const starts = [];
    const markerLines = [];
    for (let i = 0; i < lines.length; i++) {
        if (MARKER_RE.test(lines[i])) markerLines.push(i);
        else if (/^###\s/.test(lines[i])) starts.push(i);
    }

    // No entry headings at all: nothing to cut on, so fall back to the old
    // character clamp. Degenerate, but it keeps the bundle guard honest.
    if (starts.length === 0) {
        const text = section.slice(0, maxChars);
        return { text, totalEntries: 0, shownEntries: 0, omittedEntries: 0, markerVersions: markerVersionsIn(text) };
    }

    // Everything above the first entry — the section heading, plus any preamble
    // someone writes under it — always ships.
    const head = lines.slice(0, starts[0]).join('\n').replace(/\s+$/, '');
    const entries = starts.map((from, i) =>
        lines
            .slice(from, starts[i + 1] ?? lines.length)
            .join('\n')
            .replace(/\s+$/, '')
    );

    // What the release boundaries ask for, floored so a quiet stretch still
    // shows something and capped so a busy one cannot run away. The cap wins:
    // it is the backstop, and a caller who sets a low one means it.
    const wanted = entriesToCover(starts, markerLines, releasesBack);
    const budget = Math.min(Math.max(0, maxEntries), Math.max(Math.max(0, minEntries), wanted));

    const kept = [];
    let size = head.length;
    for (const entry of entries.slice(0, budget)) {
        const grown = size + 2 + entry.length;
        // Always keep the newest entry, however long: an empty panel under an
        // "Updated x → y" heading says less than one oversized entry does.
        if (kept.length > 0 && grown > maxChars) break;
        kept.push(entry);
        size = grown;
    }

    const omittedEntries = entries.length - kept.length;
    const parts = [head, ...kept];
    if (omittedEntries > 0) parts.push(omissionNote(omittedEntries));
    const text = `${parts.filter(Boolean).join('\n\n')}\n`;
    return {
        text,
        totalEntries: entries.length,
        shownEntries: kept.length,
        omittedEntries,
        markerVersions: markerVersionsIn(text),
    };
}
