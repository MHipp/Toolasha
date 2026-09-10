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
 * So the slice is counted in entries, not characters: the newest
 * {@link DEFAULT_MAX_ENTRIES} `###` entries, each one whole, with a character
 * ceiling kept only as a backstop against a body that grows in the other
 * direction. When entries are left out the slice says so in one line, so the
 * panel ends deliberately rather than just stopping.
 *
 * This lives outside `rollup.config.js` so it can be tested directly: it is the
 * only part of the plugin with any judgement in it.
 */

/**
 * How many entries ship.
 *
 * The fork has published ~86 releases and accumulated ~615 unreleased entries,
 * so a release carries about seven changes. Twelve covers a typical release with
 * room for a busy one, and roughly two releases for someone who skipped one —
 * which is about as far back as a heading reading "Updated 3.46.0 → 3.47.0" can
 * honestly reach. It is also about as much as anyone reads in a popup that
 * stands between them and the game.
 */
export const DEFAULT_MAX_ENTRIES = 12;

/**
 * The backstop. Not the primary limit — the entry count is — but a long-winded
 * release must not be able to balloon the bundle, and entries are prose whose
 * length nobody enforces. Entries are dropped whole to stay under it.
 */
export const DEFAULT_MAX_CHARS = 20000;

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
 * The one line the panel shows in place of everything that did not fit.
 * @param {number} omitted - How many entries were left out
 * @returns {string} A markdown paragraph
 */
function omissionNote(omitted) {
    const count = omitted === 1 ? 'One earlier change is' : `${omitted} earlier changes are`;
    return `${count} not shown here — the full list is in CHANGELOG.md on GitHub.`;
}

/**
 * @typedef {object} ChangelogSlice
 * @property {string} text - The markdown to embed
 * @property {number} totalEntries - `###` entries in the unreleased section
 * @property {number} shownEntries - How many of them the slice keeps
 * @property {number} omittedEntries - How many it leaves out
 */

/**
 * Choose what the what's-new popup ships.
 *
 * Keeps the newest entries whole — an entry that would not fit under the
 * character ceiling is dropped entirely rather than truncated, because a
 * half-sentence is worse than a missing one — and appends a line naming how many
 * were left out. A section already inside both limits comes back unchanged.
 * @param {string} changelog - The whole `CHANGELOG.md`
 * @param {object} [options]
 * @param {number} [options.maxEntries] - Entry ceiling, the primary limit
 * @param {number} [options.maxChars] - Character ceiling, the backstop
 * @returns {ChangelogSlice}
 */
export function sliceForkChangelog(changelog, options = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const section = extractUnreleasedSection(changelog);
    if (!section.trim()) return { text: '', totalEntries: 0, shownEntries: 0, omittedEntries: 0 };

    const lines = section.split('\n');
    const starts = [];
    for (let i = 0; i < lines.length; i++) {
        if (/^###\s/.test(lines[i])) starts.push(i);
    }

    // No entry headings at all: nothing to cut on, so fall back to the old
    // character clamp. Degenerate, but it keeps the bundle guard honest.
    if (starts.length === 0) {
        const text = section.slice(0, maxChars);
        return { text, totalEntries: 0, shownEntries: 0, omittedEntries: 0 };
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

    const kept = [];
    let size = head.length;
    for (const entry of entries.slice(0, Math.max(0, maxEntries))) {
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
    return {
        text: `${parts.filter(Boolean).join('\n\n')}\n`,
        totalEntries: entries.length,
        shownEntries: kept.length,
        omittedEntries,
    };
}
