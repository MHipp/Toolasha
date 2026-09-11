import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { filterChangelogSince, markerVersions, stripMarkers, markerFor, omissionLine } from './changelog-markers.js';
import { sliceForkChangelog, DEFAULT_MIN_ENTRIES } from '../../../scripts/changelog-slice.js';
import { stampChangelog } from '../../../scripts/stamp-changelog-version.js';

const NOTE = '4 more changes are not shown here — the full list is in CHANGELOG.md on GitHub.';

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

describe('omissionLine', () => {
    it('says only that there is more when nothing is known about the reader', () => {
        expect(omissionLine(4)).toBe(NOTE);
        expect(omissionLine(1)).toBe('One more change is not shown here — the full list is in CHANGELOG.md on GitHub.');
    });

    it('says the missing entries are recent when the reader is further back than the slice', () => {
        expect(omissionLine(4, { sinceUpdate: true })).toBe(
            '4 more changes are not shown here, some of them newer than your last update — the full list is in CHANGELOG.md on GitHub.'
        );
        expect(omissionLine(1, { sinceUpdate: true })).toBe(
            'One more change is not shown here, and it is newer than your last update — the full list is in CHANGELOG.md on GitHub.'
        );
    });

    it('never calls the missing entries earlier ones, which is what was wrong before', () => {
        expect(omissionLine(4)).not.toContain('earlier');
        expect(omissionLine(4, { sinceUpdate: true })).not.toContain('earlier');
    });

    it('is the same sentence the build writes, so the panel can find and reword it', () => {
        // Two copies of one wording — build tooling and bundle code do not share
        // a module — so something has to hold them together.
        const slice = sliceForkChangelog(
            ['# Changelog', '', '## Unreleased — branch `main`', '', '### A\n\nBody.\n', '### B\n\nBody.\n'].join('\n'),
            { maxEntries: 1 }
        );
        expect(slice.text.trim().endsWith(omissionLine(1))).toBe(true);
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

    // Case 3 — older than everything shipped: all of it is new to them, and so
    // is some of what the slice left out, which the line now says.
    it('shows everything for a build older than the oldest marker, and says the rest is recent', () => {
        const result = filterChangelogSince(SHIPPED, '3.1.0');
        expect(result.filtered).toBe(false);
        expect(result.text).toContain('### Went out in 3.8.0 or earlier');
        expect(result.text).toContain(omissionLine(4, { sinceUpdate: true }));
        expect(result.text).not.toContain(NOTE);
    });

    it('rewords the omission line in the singular too', () => {
        const one = SHIPPED.replace(NOTE, omissionLine(1));
        expect(filterChangelogSince(one, '3.1.0').text).toContain(omissionLine(1, { sinceUpdate: true }));
    });

    it('leaves one omission line, not two', () => {
        const result = filterChangelogSince(SHIPPED, '3.1.0');
        expect(result.text.match(/not shown here/g)).toHaveLength(1);
    });

    it('has nothing to reword when the slice left nothing out', () => {
        const whole = SHIPPED.replace(`\n${NOTE}\n`, '');
        const result = filterChangelogSince(whole, '3.1.0');
        expect(result.text).not.toContain('not shown here');
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
        expect(result.text).not.toContain('not shown here');
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

describe('build and run together', () => {
    /** A changelog at build time: `perRelease[i]` entries in release 3.(50-i). */
    function built(perRelease) {
        const lines = ['# Changelog', '', '## Unreleased — branch `main`', ''];
        let entry = 0;
        perRelease.forEach((count, index) => {
            lines.push(`<!-- shipped in 3.${50 - index}.0 -->`, '');
            for (let i = 0; i < count; i++) lines.push(`### Entry ${++entry}`, '', 'A sentence about it.', '');
        });
        return lines.join('\n');
    }

    // The case that started this: a release with twenty changes in it, shown to
    // the player who was running the release before it. All twenty are theirs.
    it('shows all twenty changes when a release had twenty', () => {
        const slice = sliceForkChangelog(built([20, 7, 7, 7]));
        const result = filterChangelogSince(slice.text, '3.49.0');
        expect(result.filtered).toBe(true);
        expect(result.shownEntries).toBe(20);
        expect(result.text).toContain('### Entry 20');
        expect(result.text).not.toContain('### Entry 21');
        expect(result.text).not.toContain('not shown here');
    });

    it('shows both releases to a player who skipped one', () => {
        const slice = sliceForkChangelog(built([20, 7, 7, 7]));
        const result = filterChangelogSince(slice.text, '3.48.0');
        expect(result.shownEntries).toBe(27);
        expect(result.text).toContain('### Entry 27');
        expect(result.text).not.toContain('### Entry 28');
    });

    it('tells a player who has been away longer that the missing entries are recent', () => {
        const slice = sliceForkChangelog(built([20, 7, 7, 7]));
        const result = filterChangelogSince(slice.text, '3.40.0');
        expect(result.filtered).toBe(false);
        expect(result.text).toContain('some of them newer than your last update');
    });
});

describe('against the real CHANGELOG.md, across release states', () => {
    const real = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');

    /**
     * Three points in the changelog's life: before any release ever stamped a
     * marker, today (one marker), and one release from now (a second, newer
     * marker with a new entry shipped under it). A test pinned to today's exact
     * marker count goes red on the next release — this is what happened when
     * 3.48.0 became the first marked one — so these check the documented
     * contract instead, at all three points. Built with the modules' own
     * helpers, not hand-typed markdown, so they track the real marker format.
     */
    const states = {
        'no markers': sliceForkChangelog(stripMarkers(real)),
        'one marker (today)': sliceForkChangelog(real),
        'two markers (one release from now)': sliceForkChangelog(
            stampChangelog(real, '9.9.9').text.replace(
                markerFor('9.9.9'),
                `${markerFor('9.9.9')}\n\n### Something new for 9.9.9\n\nBody text.`
            )
        ),
    };

    it('ships exactly the floor while there are fewer than two markers', () => {
        for (const [label, slice] of Object.entries(states)) {
            if (slice.markerVersions.length >= 2) continue;
            expect(slice.shownEntries, label).toBe(DEFAULT_MIN_ENTRIES);
        }
    });

    it.each(Object.entries(states))(
        'falls back to the whole marker-stripped slice for a first run (%s)',
        (_label, slice) => {
            for (const since of [null, undefined, '']) {
                const result = filterChangelogSince(slice.text, since);
                expect(result.filtered).toBe(false);
                expect(result.text).toBe(stripMarkers(slice.text));
            }
        }
    );

    it.each(Object.entries(states).filter(([, slice]) => slice.markerVersions.length > 0))(
        'falls back to the whole marker-stripped slice when nothing is newer than the newest marker (%s)',
        (_label, slice) => {
            const result = filterChangelogSince(slice.text, slice.markerVersions[0]);
            expect(result.filtered).toBe(false);
            expect(result.text).toBe(stripMarkers(slice.text));
        }
    );

    it.each(Object.entries(states).filter(([, slice]) => slice.markerVersions.length > 0))(
        'still falls back for a build older than every marker, but rewords the omission line (%s)',
        (_label, slice) => {
            const result = filterChangelogSince(slice.text, '0.0.1');
            expect(result.filtered).toBe(false);
            // Documented as a different case from the plain fallbacks above: all
            // of the slice is new to this reader, and so is some of what it left
            // out, so the omission line says that rather than staying silent
            // about it — the text is NOT simply the marker-stripped slice.
            if (slice.omittedEntries > 0) {
                expect(result.text).toContain(omissionLine(slice.omittedEntries, { sinceUpdate: true }));
            } else {
                expect(result.text).toBe(stripMarkers(slice.text));
            }
        }
    );

    it("once a newer release stamps a marker above today's, the older entries drop out", () => {
        const slice = states['one marker (today)'];
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
