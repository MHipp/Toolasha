import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { filterChangelogSince, markerVersions, stripMarkers, markerFor } from './changelog-markers.js';
import { sliceForkChangelog } from '../../../scripts/changelog-slice.js';

const NOTE = '4 earlier changes are not shown here — the full list is in CHANGELOG.md on GitHub.';

/**
 * A shipped slice with three releases behind it. Entries are newest-first, and
 * a marker means "everything below me had shipped by then" — so the entries
 * between two markers are the newer one's release, and the entries above every
 * marker are not released yet.
 */
const SHIPPED = `## Unreleased — branch \`main\`

### Not released yet

Body.

<!-- shipped in 3.10.0 -->

### Went out in 3.10.0

Body.

<!-- shipped in 3.9.0 -->

### Went out in 3.9.0

Body.

<!-- shipped in 3.8.0 -->

### Went out in 3.8.0 or earlier

Body.

${NOTE}
`;

/** What the panel would have drawn before any of this existed. */
const UNMARKED = stripMarkers(SHIPPED);

describe('markerVersions', () => {
    it('reads the markers in document order, newest first', () => {
        expect(markerVersions(SHIPPED)).toEqual(['3.10.0', '3.9.0', '3.8.0']);
    });

    it('ignores comments that are not markers', () => {
        expect(markerVersions('<!-- shipped -->\n<!-- shipped in main -->\n<!-- todo -->')).toEqual([]);
    });
});

describe('stripMarkers', () => {
    it('removes markers and the hole each one leaves', () => {
        expect(stripMarkers(SHIPPED)).not.toContain('shipped in');
        expect(stripMarkers(SHIPPED)).not.toMatch(/\n\n\n/);
    });
});

describe('filterChangelogSince', () => {
    it('never leaves a marker in what the panel draws', () => {
        for (const since of [null, '1.0.0', '3.9.0', '3.10.0', '99.0.0']) {
            expect(filterChangelogSince(SHIPPED, since).text).not.toContain('shipped in');
        }
    });

    // Case 1 — no markers at all. True for a full release cycle after this
    // lands, because the first marker only appears at the next release.
    it('changes nothing when the slice carries no markers', () => {
        const result = filterChangelogSince(UNMARKED, '3.9.0');
        expect(result.filtered).toBe(false);
        expect(result.text).toBe(UNMARKED);
    });

    // Case 2 — first run, nothing stored to compare against.
    it('shows everything when there is no stored version', () => {
        for (const since of [null, undefined, '']) {
            const result = filterChangelogSince(SHIPPED, since);
            expect(result.filtered).toBe(false);
            expect(result.text).toBe(UNMARKED);
        }
    });

    // Case 3 — older than everything shipped: all of it is new to them, and the
    // slice's own omission line is still true, so it stays.
    it('shows everything, note and all, for a build older than the oldest marker', () => {
        const result = filterChangelogSince(SHIPPED, '3.1.0');
        expect(result.filtered).toBe(false);
        expect(result.text).toContain(NOTE);
        expect(result.text).toContain('### Went out in 3.8.0 or earlier');
    });

    // Case 4 — the case this exists for.
    it('shows only what is newer than the stored version', () => {
        const result = filterChangelogSince(SHIPPED, '3.9.0');
        expect(result.filtered).toBe(true);
        expect(result.shownEntries).toBe(2);
        expect(result.totalEntries).toBe(4);
        expect(result.text).toContain('### Not released yet');
        expect(result.text).toContain('### Went out in 3.10.0');
        expect(result.text).not.toContain('### Went out in 3.9.0');
        expect(result.text).not.toContain('### Went out in 3.8.0');
        // The omission line names entries older than the slice, which are older
        // than the ones just hidden — noise once the list is "since your build".
        expect(result.text).not.toContain(NOTE);
        // The section heading always survives.
        expect(result.text.startsWith('## Unreleased')).toBe(true);
    });

    // Case 5 — stored version equal to the build: a dev build, or a rebuild with
    // no bump. `describeUpdate` calls that "New in x", and what is new is what
    // sits above the newest marker.
    it('shows the not-yet-released entries when the stored version is the newest release', () => {
        const result = filterChangelogSince(SHIPPED, '3.10.0');
        expect(result.filtered).toBe(true);
        expect(result.shownEntries).toBe(1);
        expect(result.text).toContain('### Not released yet');
        expect(result.text).not.toContain('### Went out in 3.10.0');
    });

    it('falls back to the whole slice rather than drawing an empty box', () => {
        const nothingNewer = SHIPPED.replace('### Not released yet\n\nBody.\n\n', '');
        const result = filterChangelogSince(nothingNewer, '3.10.0');
        expect(result.filtered).toBe(false);
        expect(result.text).toContain('### Went out in 3.10.0');
    });

    it('orders versions numerically, not as strings', () => {
        // String order puts 3.10.0 below 3.9.0; a build on 3.10.0 must not be
        // told about 3.10.0's own entries again.
        expect(filterChangelogSince(SHIPPED, '3.10.0').text).not.toContain('### Went out in 3.10.0');
        // And a 3.9.5 build sits between them, on 3.9.0's side.
        const between = filterChangelogSince(SHIPPED, '3.9.5');
        expect(between.text).toContain('### Went out in 3.10.0');
        expect(between.text).not.toContain('### Went out in 3.9.0');
    });

    it('handles a version with no marker of its own', () => {
        const result = filterChangelogSince(SHIPPED, '3.8.4');
        expect(result.shownEntries).toBe(3);
        expect(result.text).not.toContain('### Went out in 3.8.0 or earlier');
    });
});

describe('against the real CHANGELOG.md, which has no markers yet', () => {
    const real = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
    const slice = sliceForkChangelog(real);

    it('ships no markers today', () => {
        expect(slice.markerVersions).toEqual([]);
    });

    it('draws exactly what it draws today, whatever version the player stored', () => {
        for (const since of [null, '0.0.1', '3.46.0', '3.47.0', '99.0.0']) {
            const result = filterChangelogSince(slice.text, since);
            expect(result.filtered).toBe(false);
            expect(result.text).toBe(slice.text);
        }
    });

    it('and once a release stamps one, the older entries drop out', () => {
        // Simulate the state one release from now: today's slice marked, with a
        // newer entry written above it.
        const marked = slice.text.replace(/^(## Unreleased.*)$/m, `$1\n\n${markerFor('3.47.0')}`);
        const withNew = marked.replace(/^(## Unreleased.*)$/m, '$1\n\n### Something newer\n\nBody.');
        const result = filterChangelogSince(withNew, '3.47.0');
        expect(result.filtered).toBe(true);
        expect(result.shownEntries).toBe(1);
        expect(result.text).toContain('### Something newer');
        expect(result.text).not.toContain('shipped in');
    });
});
