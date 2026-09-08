/**
 * The last pull, store by store.
 *
 * The toast has room for one line; this is where the line's figures are broken
 * down — which store each count came from, and for every folded record the key
 * and the merge registration that folded it. Opened from the pull toast's
 * action and from the command palette, and empty until a pull has run in this
 * session, because that is exactly as long as the summary exists.
 */

import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { UNCHANGED_UNKNOWN, lastPullSummary, formatPullSummaryLine } from './pull-summary.js';

/** One shell, created on first open and reused. */
let panel = null;

/**
 * Draw the summary into the panel body.
 * @param {HTMLElement} body - The panel's scrolling body
 * @returns {void}
 */
function draw(body) {
    const summary = lastPullSummary();
    if (!summary) {
        body.appendChild(panelNote('No pull has run in this session. This is cleared on a character switch.'));
        return;
    }

    const head = panelCard(body, 'This pull');
    head.appendChild(panelLine('Summary', formatPullSummaryLine(summary)));
    if (summary.at) head.appendChild(panelLine('Applied', summary.at));
    head.appendChild(
        panelLine(
            'Unchanged',
            'unknown',
            ROW_COLORS.dim,
            `Unchanged records are ${UNCHANGED_UNKNOWN}. Counting them would mean re-reading every ` +
                'key after the write, which cannot answer the question anyway.'
        )
    );

    for (const store of summary.stores) {
        const card = panelCard(body, store.store);
        card.appendChild(panelLine('Combined', String(store.combined)));
        card.appendChild(
            panelLine(
                'Written whole',
                store.writtenWhole === null ? 'unknown' : String(store.writtenWhole),
                store.writtenWhole === null ? undefined : ROW_COLORS.good,
                store.writtenWhole === null
                    ? 'This store reported no key count — the import skipped it as unknown to this database.'
                    : 'Records the payload wrote over this device’s copy, folds excluded.'
            )
        );
        card.appendChild(
            panelLine(
                'Held',
                String(store.held),
                store.held ? ROW_COLORS.bad : undefined,
                'Kept this device’s copy because it could not be read. The downloaded entries are still ' +
                    'waiting on the next pull.'
            )
        );
        if (store.overwritten) {
            card.appendChild(
                panelLine(
                    'Overwritten',
                    String(store.overwritten),
                    ROW_COLORS.bad,
                    'The fold threw, so the downloaded copy was taken whole — this device’s entries for ' +
                        'these records are gone.'
                )
            );
        }
        card.appendChild(panelLine('Unchanged', 'unknown', undefined, UNCHANGED_UNKNOWN));

        for (const record of store.combinedRecords) {
            card.appendChild(panelNote(`· ${record.key}${record.label ? ` — ${record.label}` : ''}`));
        }
    }
}

/**
 * Show the panel, creating it on first use.
 * @returns {void}
 */
export function openPullSummaryPanel() {
    if (!panel) {
        panel = createPanel({
            id: 'sync-pull-summary',
            title: 'Last sync pull',
            size: { width: 400, height: 340 },
            draw,
            refreshMs: 5000,
        });
    }
    panel.show();
}

/**
 * Tear the panel down, for the feature's own cleanup.
 * @returns {void}
 */
export function closePullSummaryPanel() {
    panel?.hide?.();
}

export default { openPullSummaryPanel, closePullSummaryPanel };
