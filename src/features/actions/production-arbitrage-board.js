/**
 * Production Arbitrage Board
 *
 * One ranked table of every recipe in the five production skills: what a unit
 * costs you in materials, what it sells for after tax, and the margin per unit,
 * per action, per hour and — bounded by what the market actually absorbs — per
 * day. Sortable by any of the three margins, filterable by skill and by name,
 * and with a switch to hide what you cannot craft yet. A row, clicked, opens the
 * game on the action.
 *
 * The ranking itself is not here — `production-arbitrage.js` walks the recipes
 * through the same profit calculator the action panel uses and memoises the
 * result on a fingerprint of the character. What remains here is presentation:
 * the floating panel (the shared `simple-panel` shell the rest of the script's
 * panels use), the controls, the table, and the button on every production
 * skill page that opens it.
 *
 * The ranking is computed lazily on the first draw, sliced so the page never
 * freezes, and redrawn as slices land — so the board is useful a moment after
 * it opens and complete a moment after that.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { formatKMB } from '../../utils/formatters.js';
import { createPanel } from '../../utils/simple-panel.js';
import { navigateToAction, navigateToItem } from '../../utils/item-navigation.js';
import { liquidityMarkerHtml } from '../../utils/liquidity-cap.js';
import {
    PRODUCTION_SKILLS,
    rankProductionArbitrage,
    arrangeRows,
    clearProductionArbitrageCache,
} from './production-arbitrage.js';

/** The setting that turns the board on */
export const ARBITRAGE_BOARD_SETTING = 'actions_arbitrageBoard';

/** The open button's class, for the health check and for not adding it twice */
export const OPEN_BUTTON_CLASS = 'mwi-arbitrage-open';

const PANEL_ID = 'production-arbitrage';
const ACCENT = '#f0b860';
const MAX_ROWS = 150;

const SORT_LABELS = {
    day: 'Margin/day',
    hour: 'Margin/hr',
    unit: 'Margin/unit',
};

const QUALITY_LABELS = {
    'no-price': 'no price',
    'missing-input': 'input unpriced',
    stale: 'stale',
};

const INK = '#e8ecf5';
const MUTED = 'rgba(232, 236, 245, 0.55)';
const GOOD = '#4ade80';
const BAD = '#f87171';

/**
 * The production skill a skill page's title names, if any.
 * @param {HTMLElement} titleElement - The page's `GatheringProductionSkillPanel_title`
 * @returns {Object|null} The matching entry of PRODUCTION_SKILLS
 */
function skillForTitle(titleElement) {
    const text = titleElement?.textContent || '';
    return PRODUCTION_SKILLS.find((skill) => text.includes(skill.label)) || null;
}

/**
 * A small square control in the panel's idiom.
 * @param {string} label - Text
 * @param {Function} onClick - Handler
 * @param {boolean} [active=false] - Drawn pressed
 * @returns {HTMLButtonElement}
 */
function controlButton(label, onClick, active = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
        padding: '3px 8px',
        borderRadius: '4px',
        border: `1px solid ${active ? ACCENT : 'rgba(255,255,255,0.25)'}`,
        background: active ? `${ACCENT}33` : 'transparent',
        color: active ? ACCENT : INK,
        cursor: 'pointer',
        fontSize: '11px',
        fontFamily: 'inherit',
    });
    button.addEventListener('click', onClick);
    return button;
}

/**
 * A table cell.
 * @param {string|number} text - Content
 * @param {Object} [style] - Extra styles
 * @returns {HTMLTableCellElement}
 */
function cell(text, style = {}) {
    const td = document.createElement('td');
    td.textContent = text;
    Object.assign(td.style, { padding: '3px 6px', whiteSpace: 'nowrap' }, style);
    return td;
}

/**
 * A gold figure, coloured by its sign.
 * @param {number} value - Gold
 * @returns {HTMLTableCellElement}
 */
function goldCell(value) {
    const rounded = Math.round(value || 0);
    return cell(formatKMB(rounded), { textAlign: 'right', color: rounded >= 0 ? GOOD : BAD });
}

class ProductionArbitrageBoard {
    constructor() {
        this.initialized = false;
        this.panel = null;
        this.unregisterTitleObserver = null;
        this.rows = null;
        this.computing = false;
        this.progress = { done: 0, total: 0 };
        this.sort = 'day';
        this.skillHrid = null;
        this.query = '';
        this.craftableOnly = false;
        this.error = null;
        /**
         * Bumped whenever a ranking run is abandoned — a character switch
         * (disable) or a Recompute superseding one already in flight. The
         * running `ensureRows()` call captures the value at its own start and
         * checks it again at every point it resumes after an await (the
         * progress callback, and after the ranking settles); a mismatch means
         * a newer run has taken over and this one's result belongs nowhere.
         */
        this.generation = 0;
    }

    /** Feature-registry entry point */
    initialize() {
        if (this.initialized) return;
        if (!config.getSetting(ARBITRAGE_BOARD_SETTING)) return;
        this.initialized = true;

        this.panel = createPanel({
            id: PANEL_ID,
            title: 'Production Arbitrage',
            size: { width: 980, height: 560 },
            accent: ACCENT,
            // Redraws happen when slices land and when a control is used; the
            // timed redraw is only a backstop against a stale price snapshot
            refreshMs: 10 * 60_000,
            draw: (body) => this.draw(body),
        });

        this.unregisterTitleObserver = domObserver.onClass(
            'ProductionArbitrage-Title',
            'GatheringProductionSkillPanel_title',
            (titleElement) => this.injectOpenButton(titleElement)
        );
        document
            .querySelectorAll('[class*="GatheringProductionSkillPanel_title"]')
            .forEach((titleElement) => this.injectOpenButton(titleElement));
    }

    /** Feature-registry teardown */
    disable() {
        try {
            // Any ranking still in flight for the character this instance was
            // just serving is now stale — the panel it would render into is
            // about to be torn down, and a new one may be built for a
            // different character before that ranking's next callback fires.
            this.generation++;
            this.unregisterTitleObserver?.();
            this.unregisterTitleObserver = null;
            document.querySelectorAll(`.${OPEN_BUTTON_CLASS}`).forEach((button) => button.remove());
            // Released, not hidden: the handle is dropped below and
            // `initialize()` builds a fresh shell, so hiding would leave this
            // one's `character_switched` subscription on the bus with nothing
            // holding it — one more per character switch, for the life of the tab
            this.panel?.destroy();
        } catch (error) {
            console.error('[ProductionArbitrage] Disable failed part-way:', error);
        } finally {
            this.panel = null;
            this.rows = null;
            this.computing = false;
            this.initialized = false;
        }
    }

    /**
     * Put an "Arbitrage" button on a production skill page's title bar.
     * @param {HTMLElement} titleElement - The page's title element
     */
    injectOpenButton(titleElement) {
        if (!titleElement || !skillForTitle(titleElement)) return;
        if (titleElement.querySelector(`.${OPEN_BUTTON_CLASS}`)) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = OPEN_BUTTON_CLASS;
        button.textContent = 'Arbitrage';
        button.title = 'Every production recipe ranked by margin per day, hour and unit';
        button.style.cssText = `
            padding: 8px 12px;
            font-size: 14px;
            border: 1px solid rgba(255, 255, 255, 0.23);
            border-radius: 4px;
            background: transparent;
            color: inherit;
            cursor: pointer;
            font-family: inherit;
            flex-shrink: 0;
        `;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.open();
        });
        titleElement.appendChild(button);
    }

    /** Show the board, computing the ranking if it is not already known */
    open() {
        this.panel?.show();
        this.ensureRows();
    }

    /** Forget the ranking and cost everything again, even if one is already running */
    recompute() {
        clearProductionArbitrageCache();
        // Supersede whatever is in flight: bumping the generation makes its
        // next callback a no-op, and resetting `computing` is what lets
        // ensureRows() below actually start a new run instead of seeing a
        // run "already in progress" and quietly doing nothing — which is
        // what a Recompute clicked during "Costing recipes…" used to do.
        this.generation++;
        this.rows = null;
        this.computing = false;
        this.error = null;
        this.ensureRows();
    }

    /**
     * Start the ranking if nothing is known yet; redraw as it lands.
     * @returns {Promise<void>}
     */
    async ensureRows() {
        if (this.rows || this.computing) return;
        const generation = ++this.generation;
        this.computing = true;
        this.error = null;
        this.progress = { done: 0, total: 0 };
        this.panel?.render();

        try {
            const rows = await rankProductionArbitrage({
                onProgress: (done, total, partial) => {
                    // A newer run (a switch, or a Recompute) has taken over —
                    // this partial result is not for the character or the
                    // panel currently on screen
                    if (generation !== this.generation) return;
                    this.progress = { done, total };
                    this.rows = partial;
                    this.panel?.render();
                },
            });
            if (generation !== this.generation) return;
            this.rows = rows;
        } catch (error) {
            if (generation !== this.generation) return;
            console.error('[ProductionArbitrage] Ranking failed:', error);
            this.error = error;
        } finally {
            // Only this run's own bookkeeping — a superseded run must not
            // clear the `computing` flag the run that replaced it is using
            if (generation === this.generation) {
                this.computing = false;
                this.panel?.render();
            }
        }
    }

    /**
     * Draw the controls and the table into the panel body.
     * @param {HTMLElement} body - The panel's body
     */
    draw(body) {
        if (!this.rows && !this.computing) {
            // Drawn before anyone opened it — the panel was left open last time.
            // Kick the ranking off; the redraw when it lands fills the table.
            this.ensureRows();
        }

        body.appendChild(this.drawControls());

        const status = document.createElement('div');
        Object.assign(status.style, { color: MUTED, fontSize: '11px' });
        if (this.computing) {
            const { done, total } = this.progress;
            status.textContent = total ? `Costing recipes… ${done}/${total}` : 'Costing recipes…';
        } else if (this.error) {
            status.textContent = `The ranking could not be computed: ${this.error.message}`;
            status.style.color = BAD;
        } else {
            const unchecked = (this.rows || []).some((row) => row.marginPerHour > 0 && !row.volumeChecked);
            status.textContent = unchecked
                ? 'Margins/day are not yet bounded by market volume'
                : 'Margin/day is bounded by what the market absorbs; per-unit and per-action margins already include tea and tax.';
        }
        body.appendChild(status);

        body.appendChild(this.drawTable());
    }

    /**
     * The sort, skill, search and craftable controls.
     * @returns {HTMLElement}
     */
    drawControls() {
        const controls = document.createElement('div');
        Object.assign(controls.style, {
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            alignItems: 'center',
        });

        const sortLabel = document.createElement('span');
        sortLabel.textContent = 'Sort:';
        sortLabel.style.color = MUTED;
        controls.appendChild(sortLabel);
        for (const key of Object.keys(SORT_LABELS)) {
            const button = controlButton(
                SORT_LABELS[key],
                () => {
                    this.sort = key;
                    this.panel?.render();
                },
                this.sort === key
            );
            button.setAttribute('data-arb-sort', key);
            controls.appendChild(button);
        }

        const skillSelect = document.createElement('select');
        skillSelect.classList.add('toolasha-select');
        skillSelect.setAttribute('data-arb-skill', 'true');
        Object.assign(skillSelect.style, {
            marginLeft: '8px',
            padding: '2px 6px',
            borderRadius: '4px',
            border: '1px solid rgba(255,255,255,0.25)',
            background: 'rgba(14, 16, 22, 0.97)',
            color: INK,
            fontSize: '11px',
        });
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All skills';
        skillSelect.appendChild(all);
        for (const skill of PRODUCTION_SKILLS) {
            const option = document.createElement('option');
            option.value = skill.skillHrid;
            option.textContent = skill.label;
            skillSelect.appendChild(option);
        }
        skillSelect.value = this.skillHrid || '';
        skillSelect.addEventListener('change', () => {
            this.skillHrid = skillSelect.value || null;
            this.panel?.render();
        });
        controls.appendChild(skillSelect);

        const search = document.createElement('input');
        search.type = 'text';
        search.placeholder = 'Filter items…';
        search.value = this.query;
        search.setAttribute('data-arb-search', 'true');
        Object.assign(search.style, {
            padding: '2px 6px',
            borderRadius: '4px',
            border: '1px solid rgba(255,255,255,0.25)',
            background: 'rgba(14, 16, 22, 0.97)',
            color: INK,
            fontSize: '11px',
            width: '140px',
        });
        search.addEventListener('input', () => {
            this.query = search.value;
            this.redrawTable();
        });
        controls.appendChild(search);

        const craftable = controlButton(
            'Only craftable now',
            () => {
                this.craftableOnly = !this.craftableOnly;
                this.panel?.render();
            },
            this.craftableOnly
        );
        craftable.setAttribute('data-arb-craftable', 'true');
        controls.appendChild(craftable);

        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        controls.appendChild(spacer);

        const recompute = controlButton('Recompute', () => this.recompute());
        recompute.title = 'Throw the ranking away and cost everything again';
        recompute.setAttribute('data-arb-recompute', 'true');
        controls.appendChild(recompute);

        return controls;
    }

    /**
     * Replace just the table, so typing in the filter box does not rebuild the
     * box that is being typed in.
     */
    redrawTable() {
        const old = this.panel?.panel?.querySelector('[data-arb-table]');
        if (!old) {
            this.panel?.render();
            return;
        }
        old.replaceWith(this.drawTable());
    }

    /**
     * The ranked table.
     * @returns {HTMLElement}
     */
    drawTable() {
        const wrap = document.createElement('div');
        wrap.setAttribute('data-arb-table', 'true');
        wrap.style.overflow = 'auto';

        const arranged = arrangeRows(this.rows || [], {
            sort: this.sort,
            skillHrid: this.skillHrid,
            query: this.query,
            craftableOnly: this.craftableOnly,
        });

        if (!arranged.length) {
            const empty = document.createElement('div');
            empty.style.cssText = `color: ${MUTED}; padding: 16px; text-align: center;`;
            empty.textContent = this.computing ? 'Costing recipes…' : 'No recipes match';
            wrap.appendChild(empty);
            return wrap;
        }

        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11px;';

        const thead = document.createElement('thead');
        const head = document.createElement('tr');
        head.style.borderBottom = '1px solid rgba(255,255,255,0.2)';
        const columns = [
            ['#', 'center'],
            ['Item', 'left'],
            ['Skill', 'left'],
            ['Lvl', 'center'],
            ['Mat cost/unit', 'right'],
            ['Sale (after tax)', 'right'],
            ['Margin/unit', 'right'],
            ['Margin/action', 'right'],
            ['Margin/hr', 'right'],
            ['Make/day', 'right'],
            ['Margin/day', 'right'],
            ['Data', 'left'],
        ];
        for (const [label, align] of columns) {
            const th = document.createElement('th');
            th.textContent = label;
            th.style.cssText = `padding: 4px 6px; text-align: ${align}; color: ${MUTED}; font-weight: 500; white-space: nowrap;`;
            head.appendChild(th);
        }
        thead.appendChild(head);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        arranged.slice(0, MAX_ROWS).forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.setAttribute('data-arb-row', row.actionHrid);
            tr.style.cssText = 'border-bottom: 1px solid rgba(255,255,255,0.07); cursor: pointer;';
            tr.title = `${row.actionName} — click to open the action`;
            tr.addEventListener('mouseenter', () => (tr.style.background = 'rgba(255,255,255,0.05)'));
            tr.addEventListener('mouseleave', () => (tr.style.background = ''));
            tr.addEventListener('click', () => {
                if (!navigateToAction(row.actionHrid)) navigateToItem(row.itemHrid);
            });

            tr.appendChild(cell(index + 1, { textAlign: 'center', color: MUTED }));

            const name = cell(row.itemName, { color: '#93c5fd' });
            if (row.actionName && row.actionName !== row.itemName) {
                const action = document.createElement('span');
                action.textContent = ` (${row.actionName})`;
                action.style.color = MUTED;
                name.appendChild(action);
            }
            tr.appendChild(name);

            tr.appendChild(cell(row.skillLabel, { color: MUTED }));

            const level = cell(row.requiredLevel, {
                textAlign: 'center',
                color: row.levelMet ? MUTED : BAD,
            });
            level.title = row.levelMet
                ? `Requires ${row.requiredLevel}, you are ${row.level}`
                : `Requires ${row.requiredLevel}, you are ${row.level} — not craftable yet`;
            if (!row.levelMet) level.textContent = `${row.requiredLevel} ✗`;
            tr.appendChild(level);

            tr.appendChild(cell(formatKMB(Math.round(row.materialCostPerUnit)), { textAlign: 'right' }));
            tr.appendChild(cell(formatKMB(Math.round(row.saleAfterTax)), { textAlign: 'right' }));
            tr.appendChild(goldCell(row.marginPerUnit));
            tr.appendChild(goldCell(row.marginPerAction));
            tr.appendChild(goldCell(row.marginPerHour));

            const make = cell(formatKMB(Math.round(row.unitsPerDay)), { textAlign: 'right' });
            make.title = row.liquidityLimit
                ? `${row.liquidityLimit.detail} You could make ${formatKMB(Math.round(row.makeablePerDay))}/day.`
                : `What you can make in a day at ${row.actionsPerHour.toFixed(1)} actions/hr`;
            tr.appendChild(make);

            const day = goldCell(row.marginPerDay);
            if (row.liquidityLimit) {
                day.insertAdjacentHTML('beforeend', liquidityMarkerHtml(row.liquidityLimit, { compact: true }));
            }
            tr.appendChild(day);

            const quality = cell(row.quality ? QUALITY_LABELS[row.quality] || row.quality : '', {
                color: row.quality ? '#ffb74d' : MUTED,
            });
            quality.setAttribute('data-arb-quality', row.quality || 'ok');
            if (row.quality) quality.title = row.qualityNote;
            tr.appendChild(quality);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);

        if (arranged.length > MAX_ROWS) {
            const more = document.createElement('div');
            more.style.cssText = `color: ${MUTED}; text-align: center; padding: 6px; font-size: 11px;`;
            more.textContent = `Showing top ${MAX_ROWS} of ${arranged.length} recipes`;
            wrap.appendChild(more);
        }

        return wrap;
    }
}

const productionArbitrageBoard = new ProductionArbitrageBoard();

export default productionArbitrageBoard;
