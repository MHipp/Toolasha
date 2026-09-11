/**
 * Dungeon Tracker UI Run History Display
 * Handles grouping, filtering, and rendering of run history
 */

import dungeonTrackerStorage, {
    filterRunsForCharacter,
    currentCharacter,
    runIdentity,
} from './dungeon-tracker-storage.js';
import { trendsFor, directionMarker, NOT_ENOUGH_RUNS, TREND_WINDOW } from './dungeon-tracker-trends.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { formatDateTime } from '../../utils/formatters.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';

/** The run-history export, one row per run. */
export const DUNGEON_RUN_CSV_COLUMNS = [
    { key: 'timestamp', label: 'Timestamp' },
    { key: 'dungeon', label: 'Dungeon' },
    { key: 'tier', label: 'Tier' },
    { key: 'durationSeconds', label: 'Duration (s)' },
    { key: 'team', label: 'Team' },
    { key: 'teamSize', label: 'Team Size' },
    { key: 'keyCounts', label: 'Key Counts' },
    { key: 'validated', label: 'Server-timed' },
];

/**
 * A stored timestamp as ISO, or as it was when it will not parse.
 * @param {string} value - Run timestamp
 * @returns {string} ISO timestamp
 */
function isoTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toISOString();
}

/**
 * Run history as CSV rows, one per run.
 *
 * Pure and DOM-free: it reads the same run list the panel just grouped, not the
 * grouped markup, so the export carries whatever the current filters allowed —
 * in the order the groups hold it — with raw numbers a spreadsheet can sort.
 *
 * @param {Array<Object>} runs - Stored runs, as `dungeon-tracker-storage` keeps them
 * @returns {Array<Object>} Rows for `DUNGEON_RUN_CSV_COLUMNS`
 */
export function buildRunHistoryRows(runs) {
    return (runs || []).map((run) => {
        const team =
            Array.isArray(run.team) && run.team.length ? run.team : (run.teamKey || '').split(',').filter(Boolean);
        const keyCounts = run.keyCountsMap
            ? Object.entries(run.keyCountsMap)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, count]) => `${name}: ${count}`)
                  .join('; ')
            : '';

        return {
            timestamp: isoTimestamp(run.timestamp),
            dungeon: run.dungeonName || 'Unknown',
            // Tier is only known for runs recorded by routes that saw it
            tier: run.tier ?? null,
            durationSeconds: (run.duration || run.totalTime || 0) / 1000,
            team: team.length ? team.join(', ') : 'Solo',
            teamSize: team.length || 1,
            keyCounts,
            // Party runs are timed by the server's own "Key counts" timestamps;
            // a solo run only has this client's wall clock behind it
            validated: run.validated !== false,
        };
    });
}

class DungeonTrackerUIHistory {
    constructor(state, formatTimeFunc) {
        this.state = state;
        this.formatTime = formatTimeFunc;
    }

    /**
     * Escape a string for safe interpolation into innerHTML.
     * Team keys and dungeon labels derive from other players' names — untrusted input.
     * @param {string} value - Raw string
     * @returns {string} HTML-escaped string
     */
    escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    /**
     * Group runs by team
     * @param {Array} runs - Array of runs
     * @returns {Array} Grouped runs with stats
     */
    groupByTeam(runs) {
        const groups = {};

        for (const run of runs) {
            const key = run.teamKey || 'Solo';
            if (!groups[key]) {
                groups[key] = {
                    key: key,
                    label: key === 'Solo' ? 'Solo Runs' : key,
                    runs: [],
                };
            }
            groups[key].runs.push(run);
        }

        // Convert to array and calculate stats
        return Object.values(groups).map((group) => ({
            ...group,
            stats: this.calculateStatsForRuns(group.runs),
        }));
    }

    /**
     * Group runs by dungeon
     * @param {Array} runs - Array of runs
     * @returns {Array} Grouped runs with stats
     */
    groupByDungeon(runs) {
        const groups = {};

        for (const run of runs) {
            const key = run.dungeonName || 'Unknown';
            if (!groups[key]) {
                groups[key] = {
                    key: key,
                    label: key,
                    runs: [],
                };
            }
            groups[key].runs.push(run);
        }

        // Convert to array and calculate stats
        return Object.values(groups).map((group) => ({
            ...group,
            stats: this.calculateStatsForRuns(group.runs),
        }));
    }

    /**
     * Calculate stats for a set of runs
     * @param {Array} runs - Array of runs
     * @returns {Object} Stats object
     */
    calculateStatsForRuns(runs) {
        if (!runs || runs.length === 0) {
            return {
                totalRuns: 0,
                avgTime: 0,
                fastestTime: 0,
                slowestTime: 0,
            };
        }

        const durations = runs.map((r) => r.duration || r.totalTime || 0);
        const total = durations.reduce((sum, d) => sum + d, 0);

        return {
            totalRuns: runs.length,
            avgTime: Math.floor(total / runs.length),
            fastestTime: Math.min(...durations),
            slowestTime: Math.max(...durations),
        };
    }

    /**
     * Update run history display with grouping and filtering
     * @param {HTMLElement} container - Main container element
     */
    async update(container) {
        const runList = container.querySelector('#mwi-dt-run-list');
        if (!runList) return;

        // Who the list is for, settled before the store is read rather than
        // after it: a character switch landing inside that read used to move
        // the answer, and the list — with the dungeon and team dropdowns built
        // from it — was rewritten for the arriving character inside the
        // departing character's panel.
        const character = currentCharacter();

        try {
            // Get all runs from unified storage, narrowed to whoever the
            // character filter says the panel is speaking for. Everything below
            // — the dungeon and team dropdowns included — is built from that
            // narrowed list, so the choices offered are choices that have runs.
            const allRuns = filterRunsForCharacter(
                await dungeonTrackerStorage.getAllRuns(),
                this.state.filterCharacter,
                character
            );

            if (allRuns.length === 0) {
                runList.innerHTML =
                    '<div style="color: #888; font-style: italic; text-align: center; padding: 8px;">No runs yet</div>';
                // Update filter dropdowns with empty options
                this.updateFilterDropdowns(container, [], []);
                return;
            }

            // Apply filters
            let filteredRuns = allRuns;
            if (this.state.filterDungeon !== 'all') {
                filteredRuns = filteredRuns.filter((r) => r.dungeonName === this.state.filterDungeon);
            }
            if (this.state.filterTier !== 'all') {
                filteredRuns = filteredRuns.filter((r) => String(r.tier) === this.state.filterTier);
            }
            if (this.state.filterTeam !== 'all') {
                filteredRuns = filteredRuns.filter((r) => r.teamKey === this.state.filterTeam);
            }

            if (filteredRuns.length === 0) {
                runList.innerHTML =
                    '<div style="color: #888; font-style: italic; text-align: center; padding: 8px;">No runs match filters</div>';
                return;
            }

            // Group runs
            const groups =
                this.state.groupBy === 'team' ? this.groupByTeam(filteredRuns) : this.groupByDungeon(filteredRuns);

            // Trends are per dungeon+tier, so they are computed from the runs
            // the filters allowed rather than from whichever grouping the
            // panel happens to be showing. Memoised on the run list, so a
            // redraw that changed nothing recomputes nothing.
            const { groups: trendGroups, deltas } = trendsFor(filteredRuns);

            // Render grouped runs
            this.renderGroupedRuns(runList, groups, deltas);

            runList.prepend(this.trendsBlock(trendGroups));

            // The export bar sits inside the list it describes, so the redraw
            // that replaces the list replaces the bar with it. The rows come
            // from the grouped data at click time — what the filters allowed,
            // in the order the groups hold it — never from the DOM.
            runList.prepend(this.csvExportBar(groups.flatMap((group) => group.runs)));

            // Update filter dropdowns
            const dungeons = [...new Set(allRuns.map((r) => r.dungeonName).filter(Boolean))].sort();
            const teams = [...new Set(allRuns.map((r) => r.teamKey).filter(Boolean))].sort();
            const tiers = [...new Set(allRuns.map((r) => r.tier).filter((t) => t !== null && t !== undefined))].sort(
                (a, b) => a - b
            );
            this.updateFilterDropdowns(container, dungeons, teams, tiers);
        } catch (error) {
            console.error('[Dungeon Tracker UI History] Update error:', error);
            runList.innerHTML =
                '<div style="color: #ff6b6b; text-align: center; padding: 8px;">Error loading run history</div>';
        }
    }

    /**
     * Update filter dropdown options
     * @param {HTMLElement} container - Main container element
     * @param {Array} dungeons - List of dungeon names
     * @param {Array} teams - List of team keys
     */
    updateFilterDropdowns(container, dungeons, teams, tiers = []) {
        // Update dungeon filter
        const dungeonFilter = container.querySelector('#mwi-dt-filter-dungeon');
        if (dungeonFilter) {
            const currentValue = dungeonFilter.value;
            dungeonFilter.innerHTML =
                '<option value="all">All Dungeons</option>' +
                dungeons
                    .map(
                        (dungeon) => `<option value="${this.escapeHtml(dungeon)}">${this.escapeHtml(dungeon)}</option>`
                    )
                    .join('');
            // Restore selection if still valid
            if (dungeons.includes(currentValue)) {
                dungeonFilter.value = currentValue;
            } else {
                this.state.filterDungeon = 'all';
            }
        }

        // Update tier filter
        const tierFilter = container.querySelector('#mwi-dt-filter-tier');
        if (tierFilter) {
            // Restore from state, not the DOM, so a saved tier survives a reload
            // (the select is rebuilt back to "All Tiers" each render).
            const desired = String(this.state.filterTier);
            tierFilter.innerHTML =
                '<option value="all">All Tiers</option>' +
                tiers.map((tier) => `<option value="${tier}">T${tier}</option>`).join('');
            if (desired === 'all' || tiers.map(String).includes(desired)) {
                tierFilter.value = desired;
            } else {
                // The saved tier no longer exists in the data — fall back to all
                this.state.filterTier = 'all';
                tierFilter.value = 'all';
            }
        }

        // Update team filter
        const teamFilter = container.querySelector('#mwi-dt-filter-team');
        if (teamFilter) {
            const currentValue = teamFilter.value;
            teamFilter.innerHTML =
                '<option value="all">All Teams</option>' +
                teams
                    .map((team) => `<option value="${this.escapeHtml(team)}">${this.escapeHtml(team)}</option>`)
                    .join('');
            // Restore selection if still valid
            if (teams.includes(currentValue)) {
                teamFilter.value = currentValue;
            } else {
                this.state.filterTeam = 'all';
            }
        }
    }

    /**
     * A group header label, with team-member names individually clickable.
     *
     * Only the team grouping's headers are player lists ("Aster,Briar,cove");
     * dungeon headers and the Solo bucket come back escaped but unwrapped. The
     * wrap keeps the label's exact text, with each valid player name in its own
     * span that fills "/profile <name>" into chat when clicked.
     *
     * @param {Object} group - A group from groupByTeam/groupByDungeon
     * @returns {string} HTML for the header label
     */
    renderGroupLabel(group) {
        if (this.state.groupBy !== 'team' || group.key === 'Solo') {
            return this.escapeHtml(group.label);
        }

        return String(group.label)
            .split(',')
            .map((name) => {
                // A malformed name gets no click handler — plain text, never a
                // broken /profile command
                if (!VALID_PLAYER_NAME_RE.test(name)) return this.escapeHtml(name);
                const escaped = this.escapeHtml(name);
                return (
                    `<span class="mwi-dt-player-name" data-player-name="${escaped}" style="cursor: pointer; ` +
                    `text-decoration: underline dotted; text-underline-offset: 2px;" ` +
                    `title="Open ${escaped}'s profile">${escaped}</span>`
                );
            })
            .join(',');
    }

    /**
     * The trends block: one compact line per dungeon+tier.
     *
     * Duration only. The stored run shape records how long a run took and who
     * spent which keys, and says nothing about what a run paid out, so this
     * block makes no claim about earnings — see `dungeon-tracker-trends.js`.
     *
     * @param {Array<Object>} trendGroups - From `trendsFor`
     * @returns {HTMLElement} The block
     */
    trendsBlock(trendGroups) {
        const block = document.createElement('div');
        block.dataset.dungeonTrends = 'true';
        block.style.cssText =
            'border: 1px solid #444; border-radius: 4px; padding: 6px; margin: 0 0 6px 0; font-size: 10px;';

        const heading = document.createElement('div');
        heading.textContent = 'Trends';
        heading.title =
            `Average run time over the last ${TREND_WINDOW} runs against the ${TREND_WINDOW} before, ` +
            'per dungeon and tier.';
        heading.style.cssText = 'font-weight: bold; color: #4a9eff; margin-bottom: 4px;';
        block.appendChild(heading);

        if (!trendGroups.length) {
            const empty = document.createElement('div');
            empty.textContent = NOT_ENOUGH_RUNS;
            empty.style.cssText = 'color: #888; font-style: italic;';
            block.appendChild(empty);
            return block;
        }

        for (const group of trendGroups) {
            const row = document.createElement('div');
            row.dataset.trendKey = group.key;
            row.style.cssText = 'display: flex; justify-content: space-between; gap: 6px; padding: 1px 0;';

            const label = document.createElement('span');
            label.textContent = group.label;
            label.style.cssText = 'color: #ddd;';
            row.appendChild(label);

            const figures = document.createElement('span');
            figures.style.cssText = 'color: #aaa; text-align: right;';
            figures.textContent = this.trendFigures(group.trend);
            row.appendChild(figures);

            block.appendChild(row);
        }

        return block;
    }

    /**
     * One group's figures as text.
     *
     * A group without enough runs says so instead of quoting a rate, and a
     * group with no earlier window quotes its rate without inventing a
     * comparison for it.
     *
     * @param {Object} trend - From `computeTrend`
     * @returns {string} The figures
     */
    trendFigures(trend) {
        if (!trend.enough) return `${NOT_ENOUGH_RUNS} (${trend.runCount})`;

        const parts = [`avg ${this.formatTime(trend.recentAvgMs)}`];

        if (trend.direction) {
            const percent = Math.abs(trend.changePercent).toFixed(1);
            const word = trend.direction === 'flat' ? 'flat' : `${percent}% ${trend.direction}`;
            parts.push(`${directionMarker(trend.direction)} ${word} vs earlier runs`);
        } else {
            parts.push('no earlier window yet');
        }

        if (trend.runsPerHour !== null) parts.push(`${trend.runsPerHour.toFixed(1)} runs/hr`);

        return parts.join(' | ');
    }

    /**
     * A single run against the rolling average of the five before it.
     *
     * @param {Object|null} delta - From `buildRunDeltas`, or null when the run
     *   has too little history behind it to be compared
     * @returns {string} HTML for the marker, or an empty string
     */
    renderDeltaMarker(delta) {
        if (!delta) return '';

        const colors = { faster: '#6bcf7f', slower: '#ff6b6b', flat: '#888' };
        const percent = Math.abs(delta.percent).toFixed(0);
        const text = delta.direction === 'flat' ? '→ even' : `${directionMarker(delta.direction)} ${percent}%`;

        return (
            `<span class="mwi-dt-run-delta" style="color: ${colors[delta.direction]}; font-size: 9px; ` +
            `margin-right: 6px;" title="Against the rolling average of the previous 5 runs">` +
            `${this.escapeHtml(text)}</span>`
        );
    }

    /**
     * An Export CSV bar for the run list.
     *
     * Only built when there are runs to write — `update` bails out before this
     * on an empty or fully filtered-out list, so an exportless empty state
     * never shows a button with nothing behind it.
     *
     * @param {Array} runs - The runs the current grouping holds, in group order
     * @returns {HTMLElement} The bar
     */
    csvExportBar(runs) {
        const bar = document.createElement('div');
        bar.dataset.csvExport = 'dungeon-runs';
        bar.style.cssText = 'display: flex; justify-content: flex-end; margin: 0 0 6px 0;';

        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.title = 'Save the listed runs as a spreadsheet — one row per run, raw numbers.';
        button.style.cssText =
            'background: none; border: 1px solid #555; color: #aaa; border-radius: 2px; ' +
            'font-size: 9px; padding: 1px 6px; cursor: pointer;';
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            try {
                const rows = buildRunHistoryRows(runs);
                if (!rows.length) return;
                downloadCsv(csvFilename('dungeon-runs'), toCsv(rows, DUNGEON_RUN_CSV_COLUMNS));
            } catch (error) {
                console.error('[Dungeon Tracker UI History] CSV export failed:', error);
            }
        });

        bar.appendChild(button);
        return bar;
    }

    /**
     * Render grouped runs
     * @param {HTMLElement} runList - Run list container
     * @param {Array} groups - Grouped runs with stats
     * @param {Map<string, Object>} [deltas] - Per-run deltas, keyed by `runIdentity`
     */
    renderGroupedRuns(runList, groups, deltas) {
        let html = '';

        for (const group of groups) {
            const avgTime = this.formatTime(group.stats.avgTime);
            const bestTime = this.formatTime(group.stats.fastestTime);
            const worstTime = this.formatTime(group.stats.slowestTime);

            // Check if this group is expanded
            const isExpanded = this.state.expandedGroups.has(group.label);
            const displayStyle = isExpanded ? 'block' : 'none';
            const toggleIcon = isExpanded ? '▲' : '▼';

            html += `
                <div class="mwi-dt-group" style="
                    margin-bottom: 8px;
                    border: 1px solid #444;
                    border-radius: 4px;
                    padding: 8px;
                ">
                    <div style="
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 6px;
                        cursor: pointer;
                    " class="mwi-dt-group-header" data-group-label="${this.escapeHtml(group.label)}">
                        <div style="flex: 1;">
                            <div style="font-weight: bold; color: #4a9eff; margin-bottom: 2px;">
                                ${this.renderGroupLabel(group)}
                            </div>
                            <div style="font-size: 10px; color: #aaa;">
                                Runs: ${group.stats.totalRuns} | Avg: ${avgTime} | Best: ${bestTime} | Worst: ${worstTime}
                            </div>
                        </div>
                        <span class="mwi-dt-group-toggle" style="color: #aaa; font-size: 10px;">${toggleIcon}</span>
                    </div>
                    <div class="mwi-dt-group-runs" style="
                        display: ${displayStyle};
                        border-top: 1px solid #444;
                        padding-top: 6px;
                        margin-top: 4px;
                    ">
                        ${this.renderRunList(group.runs, deltas)}
                    </div>
                </div>
            `;
        }

        runList.innerHTML = html;

        // Attach toggle handlers
        runList.querySelectorAll('.mwi-dt-group-header').forEach((header) => {
            header.addEventListener('click', () => {
                const groupLabel = header.dataset.groupLabel;
                const runsDiv = header.nextElementSibling;
                const toggle = header.querySelector('.mwi-dt-group-toggle');

                if (runsDiv.style.display === 'none') {
                    runsDiv.style.display = 'block';
                    toggle.textContent = '▲';
                    this.state.expandedGroups.add(groupLabel);
                } else {
                    runsDiv.style.display = 'none';
                    toggle.textContent = '▼';
                    this.state.expandedGroups.delete(groupLabel);
                }
            });
        });

        // Player-name clicks fill "/profile <name>" into chat. Stopped, so the
        // click does not also toggle the group open or shut underneath it.
        runList.querySelectorAll('.mwi-dt-player-name').forEach((el) => {
            el.addEventListener('click', (event) => {
                event.stopPropagation();
                openPlayerProfile(el.dataset.playerName, { logPrefix: 'DungeonHistory' });
            });
        });

        // Attach delete handlers
        runList.querySelectorAll('.mwi-dt-delete-run').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                const runTimestamp = e.target.closest('[data-run-timestamp]').dataset.runTimestamp;

                // Delete the run from unified storage
                await dungeonTrackerStorage.deleteRun(runTimestamp);

                // Trigger refresh via callback
                if (this.onDeleteCallback) {
                    this.onDeleteCallback();
                }
            });
        });
    }

    /**
     * Render individual run list
     * @param {Array} runs - Array of runs
     * @param {Map<string, Object>} [deltas] - Per-run deltas, keyed by `runIdentity`
     * @returns {string} HTML for run list
     */
    renderRunList(runs, deltas) {
        let html = '';
        runs.forEach((run, index) => {
            const runNumber = runs.length - index;
            const timeStr = this.formatTime(run.duration || run.totalTime || 0);
            // A solo run is timed by this client's clock rather than the server's
            // party timestamps. Marked, so the two are never read as equal evidence.
            const clientTimed = run.validated === false;
            const timeMark = clientTimed
                ? ' <span style="color: #ffc107; font-size: 9px;" title="Timed by this client’s clock ' +
                  '(solo run — no party timestamps to check it against)">~</span>'
                : '';
            const dateObj = new Date(run.timestamp);
            const dateTime = formatDateTime(dateObj);
            const dungeonLabel = run.dungeonName || 'Unknown';
            const delta = deltas?.get(runIdentity(run)) || null;

            html += `
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 4px 0;
                    border-bottom: 1px solid #333;
                    font-size: 10px;
                " data-run-timestamp="${run.timestamp}">
                    <span style="color: #aaa; min-width: 25px;">#${runNumber}</span>
                    <span style="color: #fff; flex: 1; text-align: center;">
                        ${timeStr}${timeMark} <span style="color: #888; font-size: 9px;">(${dateTime})</span>
                    </span>
                    ${this.renderDeltaMarker(delta)}
                    <span style="color: #888; margin-right: 6px; font-size: 9px;">${this.escapeHtml(dungeonLabel)}</span>
                    <button class="mwi-dt-delete-run" style="
                        background: none;
                        border: 1px solid #ff6b6b;
                        color: #ff6b6b;
                        cursor: pointer;
                        font-size: 9px;
                        padding: 1px 4px;
                        border-radius: 2px;
                        font-weight: bold;
                    " title="Delete this run">✕</button>
                </div>
            `;
        });
        return html;
    }

    /**
     * Set callback for when a run is deleted
     * @param {Function} callback - Callback function
     */
    onDelete(callback) {
        this.onDeleteCallback = callback;
    }
}

export default DungeonTrackerUIHistory;
