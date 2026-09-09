/**
 * Ability Book panel
 *
 * Every ability at once: what its next level costs in books, and which of them
 * is the cheapest thing you could buy right now.
 *
 * The Item Dictionary already answers this for one ability — the one whose book
 * you happen to be looking at. That is the wrong shape for the question people
 * actually ask, which is not "what does this cost" but "what should I buy". You
 * cannot answer the second by opening the first eighteen times.
 *
 * ## Cheapest is not nearest
 *
 * The ability closest to its next level is rarely the cheapest to level. Books
 * differ in the experience they grant and by orders of magnitude in price, so
 * the ability two hundred experience from a level can cost more than one four
 * thousand away. The panel sorts by cost for that reason, and the overlay row
 * carries the winner.
 *
 * An unpriced book is **unknown, not free**. Treating a missing price as zero
 * would make whatever nobody is selling win every time, which is precisely
 * backwards. Those rows say so and are excluded from the cheapest.
 *
 * The arithmetic is in `utils/ability-books.js`, shared with the dictionary
 * calculator so the two cannot disagree about the same number.
 *
 * The panel is BRead's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable, makeResizable } from '../../utils/floating-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { itemIcon, linkToMarketplace, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';
import { testerShopEnabled, testerShopCoinCost } from '../../utils/tester-shop.js';
import { openTesterShopPage, setShopFilter } from '../../utils/tester-shop-nav.js';
import { createSkillHistory } from '../../utils/skill-history.js';
import { rateFor as checkpointRateFor, rateWindowLabel } from './ability-checkpoints.js';
import { abilityPlan, cheapestNextLevel, aimedTotals, bookItemFor } from '../../utils/ability-books.js';
import { registerCommand } from '../../utils/command-registry.js';

const PANEL_ID = 'toolasha-ability-book-panel';
const GEOMETRY_KEY = 'abilityBookPanel';
const DEFAULT_PANEL = { width: 500, height: 420 };
const REFRESH_MS = 5000;

const COLORS = {
    background: 'rgba(14, 16, 22, 0.97)',
    card: 'rgba(255, 255, 255, 0.04)',
    headerBg: 'rgba(28, 24, 34, 0.9)',
    border: 'rgba(190, 170, 255, 0.32)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.5)',
    accent: '#b9a4ff',
    // Its own orange rather than the palette's gold, because books and cost sit
    // side by side and two figures in one colour read as one figure
    books: '#ffa657',
};

/** The level every ability is being aimed at, when one is set */
let sharedTarget = null;

/**
 * A level chosen for one ability, which overrides the shared one.
 *
 * Per ability rather than one for all, because the levels are not level: taking
 * an ability at 41 and one at 70 both to 100 are different purchases, and the
 * question is usually about one of them.
 *
 * @type {Map<string, number>}
 */
const abilityTargets = new Map();

/**
 * How fast each ability is earning experience.
 *
 * Same measurement a skill rate uses — abilities have an hrid and an experience
 * total, which is all it reads. Ten minutes back rather than session start, so a
 * change of activity shows up rather than being averaged away.
 */
const abilityHistory = createSkillHistory();

/**
 * The target set for one ability.
 * @param {string} abilityHrid - Which ability
 * @returns {number|null}
 */
function targetFor(abilityHrid) {
    return abilityTargets.get(abilityHrid) ?? sharedTarget;
}

/** Put every ability back to its next level */
export function resetAbilityTargets() {
    abilityTargets.clear();
    sharedTarget = null;
}

/**
 * Fills the quantity box in the game's buy dialog.
 *
 * Registered on first use rather than when the panel opens: the dialog is
 * reached by navigating to the marketplace and then clicking + New Buy Listing,
 * which can be a while later and with the panel closed in between. An observer
 * that only lives as long as the panel would miss exactly that.
 */
const autofill = createAutofillManager('AbilityBookPanel');
let autofillReady = false;

/**
 * Open a book's marketplace listing with the number you need already typed in.
 *
 * The count is the point of the panel and retyping it into the dialog is where
 * it gets rounded to something convenient — 2,800 rather than 2,809 is one book
 * short of a level, discovered a fortnight later.
 *
 * @param {string} itemHrid - The book
 * @param {number|null} books - How many, or null when it cannot be worked out
 */
export function buyBooks(itemHrid, books) {
    // The shop is a detour taken only when it applies: the marketplace path
    // stays synchronous, so a click that was never going to the shop is not
    // deferred a turn for the sake of a question already answered
    if (boughtFromTesterShop(itemHrid)) {
        openInTesterShop(itemHrid, books).then((opened) => {
            // The shop could not be reached; the marketplace still sells books
            if (!opened) buyOnMarketplace(itemHrid, books);
        });
        return;
    }

    buyOnMarketplace(itemHrid, books);
}

/**
 * The marketplace listing for a book, with the count already typed in.
 * @param {string} itemHrid - The book
 * @param {number|null} books - How many, or null when it cannot be worked out
 */
function buyOnMarketplace(itemHrid, books) {
    armAutofill();

    // One-shot, and armed for this book alone: a standing quantity that is not
    // tied to an item fills in the next thing you buy, whatever it is
    if (books > 0) autofill.setQuantity(Math.ceil(books), { itemHrid });
    else autofill.clearQuantity();

    navigateToMarketplace(itemHrid);
}

/** Register the buy-dialog observer, once, on first use */
function armAutofill() {
    if (autofillReady) return;
    autofill.initialize();
    autofillReady = true;
}

/**
 * Whether a book is bought from the Tester shop rather than the marketplace.
 *
 * Sold in the shop and priced against it is the whole condition — the same one
 * the Item Dictionary's book panel uses, so the two surfaces cannot disagree
 * about where a book comes from.
 *
 * @param {string} itemHrid - The book
 * @returns {boolean}
 */
function boughtFromTesterShop(itemHrid) {
    return testerShopEnabled() && testerShopCoinCost(itemHrid) > 0;
}

/**
 * Open a book in the Tester shop, filtered to it and with the count armed.
 *
 * Nothing here opens the item's card or presses Buy: one click is one game
 * action, and the player's click is the purchase. A shop that cannot be reached
 * reports it so the caller can fall back to the marketplace, which sells books
 * too.
 *
 * @param {string} itemHrid - The book
 * @param {number|null} books - How many to arm, or null to arm nothing
 * @returns {Promise<boolean>} Whether the shop took the click
 */
async function openInTesterShop(itemHrid, books) {
    const testerTab = await openTesterShopPage();
    if (!testerTab) return false;

    // Filter and arm only after the tab is selected: selecting a shop tab is
    // what clears an armed quantity
    setShopFilter(dataManager.getInitClientData?.()?.itemDetailMap?.[itemHrid]?.name || '');
    if (books > 0) {
        armAutofill();
        autofill.setPendingCalculation(() => Math.ceil(books), { itemHrid });
    }
    return true;
}

/**
 * Open a book where it is bought, with nothing armed.
 *
 * The header's icon, which is a look rather than a purchase — it carries no
 * count, so there is no quantity to fill in.
 *
 * @param {string} itemHrid - The book
 */
function openBook(itemHrid) {
    if (boughtFromTesterShop(itemHrid)) {
        openInTesterShop(itemHrid, null).then((opened) => {
            if (!opened) navigateToMarketplace(itemHrid);
        });
        return;
    }

    navigateToMarketplace(itemHrid);
}

/**
 * What a book costs to buy, floored at the Tester shop.
 *
 * The floor is the shape `resolveItemPrice` already uses: buy-side only, and
 * the shop replaces a price only when it is strictly cheaper — only when there
 * is no quote at all does it stand in for a missing one. A dearer shop never
 * raises a price.
 *
 * This is what the panel ranks on, not only what it prints: `costToNext` is the
 * sort key and the header's "cheapest next level", so a book cheaper in the
 * shop than on the market has to be costed at the shop or the panel names an
 * ability that is not the cheapest thing to buy.
 *
 * @param {string} itemHrid - The book
 * @returns {{price: number, floored: boolean}} `floored` is whether the figure is the shop's
 */
function bookBuyPrice(itemHrid) {
    const marketAsk = getItemPrices(itemHrid)?.ask || 0;
    const shopCost = testerShopEnabled() ? testerShopCoinCost(itemHrid) : 0;
    const floored = shopCost > 0 && (!(marketAsk > 0) || shopCost < marketAsk);
    return { price: floored ? shopCost : marketAsk, floored };
}

/**
 * An ability's readable name.
 * @param {string} abilityHrid - e.g. `/abilities/quick_shot`
 * @returns {string}
 */
function abilityName(abilityHrid) {
    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[abilityHrid];
    if (detail?.name) return detail.name;

    return String(abilityHrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * How a row's rate must describe itself.
 *
 * A per-hour figure drawn from a fortnight of checkpoints is only honest with
 * the window attached: three days of fighting spread over fourteen is a real
 * measurement of a fortnight and a badly misleading one of an hour of fighting.
 * The days-with-combat count travels with the number for that reason.
 *
 * @param {Object} plan - One ability's plan
 * @returns {string} Tooltip text
 */
function rateTitle(plan) {
    if (!plan.experiencePerHour) return 'No experience gained yet, so there is no rate to measure.';
    if (!plan.rateWindow) return 'Measured over the last ten minutes of play.';
    const { from, to } = plan.rateWindow;
    return `Measured from daily checkpoints, ${rateWindowLabel(plan.rateWindow)} (${from} to ${to}). Idle days count as the zeroes they were.`;
}

/**
 * A plan for every ability the character has.
 *
 * Exported because the overlay row reads it while the panel is closed, and
 * because a disagreement between the row and the panel would be here.
 *
 * @param {number|null|Function} [target] - A level beyond the next one, or
 *   `(abilityHrid) => level|null` when each ability has its own
 * @returns {Array<Object>} From `abilityPlan`, cheapest first
 */
export function abilityPlans(target = targetFor) {
    const data = dataManager.getInitClientData?.();
    const table = data?.levelExperienceTable;
    if (!table) return [];

    const abilities = equippedAbilities();
    // The rate the panel's time column divides by. Sampled here rather than in
    // the panel so the reading is taken whether or not the panel is open — a
    // rate that only starts measuring when you look at it takes ten minutes to
    // say anything, every time.
    abilityHistory.sample(
        abilities.map((ability) => ({ skillHrid: ability.abilityHrid, experience: ability.experience }))
    );

    const plans = [];
    for (const ability of abilities) {
        if (!ability?.abilityHrid) continue;

        const itemHrid = bookItemFor(ability.abilityHrid);
        const perBookExperience = data?.itemDetailMap?.[itemHrid]?.abilityBookDetail?.experienceGain;

        const { price, floored } = bookBuyPrice(itemHrid);
        const plan = abilityPlan({
            ability,
            perBookExperience,
            bookPrice: price,
            table,
            targetLevel: typeof target === 'function' ? target(ability.abilityHrid) : target,
        });
        if (plan) {
            // A fortnight of daily checkpoints measures the thing this column
            // claims — "when will this level" — and ten minutes of a fight does
            // not. So the long window wins whenever there is one, and the
            // ten-minute reading stays as the fallback it always was: an
            // account whose checkpoints start today has nothing else, and had
            // nothing else before this existed either.
            const live = abilityHistory.rateFor(ability.abilityHrid);
            const window = checkpointRateFor(ability.abilityHrid);
            plans.push({
                ...plan,
                name: abilityName(ability.abilityHrid),
                // Whether the figure beside it is the shop's rather than the
                // market's. Every surface that prints the cost has to say which
                shopPriced: floored,
                experiencePerHour: window ? window.experiencePerHour : live,
                // Null means the figure beside it is the live ten-minute rate.
                // Every surface that prints the rate has to say which it is —
                // the two differ by whatever idleness the long window contains
                rateWindow: window || null,
            });
        }
    }

    // Cheapest first, and the ones with no price last rather than first — they
    // are the least informative rows, not the most attractive
    return plans.sort((a, b) => {
        if (a.costToNext === null) return b.costToNext === null ? a.name.localeCompare(b.name) : 1;
        if (b.costToNext === null) return -1;
        return a.costToNext - b.costToNext;
    });
}

/**
 * The abilities actually in your kit, with their level and experience.
 *
 * Two sources, and both are needed. `combatUnit.combatAbilities` is the live
 * equipped state — the five slots — and is the only place that says which
 * abilities are in use rather than merely owned. `characterAbilities` is the
 * only place that carries experience, which is what "how far to the next level"
 * turns on. Neither alone answers the question.
 *
 * Not `getInitClientData()`, which is static game data: it has an
 * `abilityDetailMap` describing every ability in the game and nothing about
 * yours. Reading the character out of it is how this panel first shipped
 * showing an empty list.
 *
 * @returns {Array<{abilityHrid: string, level: number, experience: number}>}
 */
export function equippedAbilities() {
    const character = dataManager.characterData;
    const equipped = character?.combatUnit?.combatAbilities || [];
    const owned = character?.characterAbilities || [];

    const abilities = [];
    for (const slot of equipped) {
        if (!slot?.abilityHrid) continue;

        const known = owned.find((entry) => entry.abilityHrid === slot.abilityHrid);
        abilities.push({
            abilityHrid: slot.abilityHrid,
            level: known?.level ?? slot.level ?? 0,
            // Without the experience the level is a floor, not a position: every
            // ability would read as freshly levelled and every plan would be
            // the full cost of a level
            experience: known?.experience ?? 0,
        });
    }
    return abilities;
}

class AbilityBookPanel {
    constructor() {
        this.panel = null;
        this.bodyEl = null;
        this.refreshId = null;
    }

    show() {
        if (this.panel && document.body.contains(this.panel)) {
            bringPanelToFront(this.panel);
            return;
        }
        this._create();
    }

    hide() {
        this._remove();
    }

    toggle() {
        if (this.panel) this.hide();
        else this.show();
    }

    _create() {
        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        Object.assign(this.panel.style, {
            position: 'fixed',
            top: '150px',
            left: '130px',
            zIndex: String(config.Z_FLOATING_PANEL),
            // Clamped so the first open on a phone is not wider than the screen
            width: `min(${DEFAULT_PANEL.width}px, 92vw)`,
            height: `min(${DEFAULT_PANEL.height}px, 80vh)`,
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            color: COLORS.text,
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
        });

        this.headerEl = this._header();
        this.panel.appendChild(this.headerEl);

        this.bodyEl = document.createElement('div');
        Object.assign(this.bodyEl.style, {
            flex: '1',
            overflow: 'auto',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            fontVariantNumeric: 'tabular-nums',
        });
        this.panel.appendChild(this.bodyEl);

        this.detachDrag = makeDraggable(this.panel, this.headerEl, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
        this.detachResize = makeResizable(this.panel, {
            minWidth: 400,
            minHeight: 240,
            onResize: (size) => saveGeometry(GEOMETRY_KEY, size),
        });

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: 400, height: 240 });

        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header: this.headerEl,
            body: this.bodyEl,
            panelKey: GEOMETRY_KEY,
            beforeEl: this.headerEl.lastElementChild,
            accent: COLORS.text,
        });

        this._render();
        this.refreshId = setInterval(() => {
            if (document.hidden) return;
            this._refresh();
        }, REFRESH_MS);
    }

    _header() {
        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            padding: '7px 8px 7px 11px',
            background: COLORS.headerBg,
            borderBottom: `1px solid ${COLORS.border}`,
            userSelect: 'none',
            flex: '0 0 auto',
        });

        const title = document.createElement('span');
        title.textContent = 'Ability Books';
        title.style.fontWeight = 'bold';
        title.style.color = COLORS.accent;

        // The same summary the overlay tile carries, so the panel you opened
        // from it opens showing the figure you opened it for
        this.headerBest = document.createElement('span');
        Object.assign(this.headerBest.style, { display: 'flex', alignItems: 'center', gap: '5px' });

        const spacer = document.createElement('div');
        spacer.style.flex = '1';

        const reset = document.createElement('button');
        reset.textContent = 'Reset';
        Object.assign(reset.style, {
            background: 'rgba(255, 255, 255, 0.08)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '11px',
            padding: '2px 9px',
        });
        reset.title = 'Put every ability back to its next level.';
        reset.addEventListener('click', (event) => {
            event.stopPropagation();
            resetAbilityTargets();
            this._render();
        });

        const close = document.createElement('button');
        close.textContent = '✕';
        Object.assign(close.style, {
            background: 'none',
            border: 'none',
            color: COLORS.text,
            cursor: 'pointer',
            fontSize: '13px',
            padding: '2px 4px',
        });
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            this.hide();
        });

        header.append(title, this.headerBest, spacer, reset, close);
        return header;
    }

    /**
     * The cheapest next level, written the way the tile writes it.
     * @param {Object|null} best - From `cheapestNextLevel`
     */
    _drawHeaderBest(best) {
        this.headerBest.replaceChildren();
        if (!best) return;

        const icon = itemIcon(best.itemHrid, 18);
        linkToMarketplace(icon, best.itemHrid, openBook);
        if (best.shopPriced) icon.title = 'Open in the Tester shop';

        this.headerBest.append(
            icon,
            this._value(formatWithSeparator(best.booksToNext), ROW_COLORS.good),
            this._label('books'),
            this._value(formatKMB(best.costToNext), ROW_COLORS.gold)
        );
        // A shop-floored figure is not a market quote and must not read as one
        if (best.shopPriced) this.headerBest.append(this._label(' (Tester shop)'));
        this.headerBest.title =
            `${best.name} is the cheapest next ability level you could buy right now.` +
            (best.shopPriced ? ' Costed at the Tester shop, which sells the book for less than the market.' : '');
    }

    /** The periodic redraw, which leaves a field being typed into alone */
    _refresh() {
        const active = document.activeElement;
        if (this.panel?.contains(active) && active.tagName === 'INPUT') return;
        this._render();
    }

    _render() {
        if (!this.bodyEl) return;

        const plans = abilityPlans();
        // `costToNext` is there whatever target a row is aimed at, and the next
        // level is what the header is about — the thing you could go and buy now
        this._drawHeaderBest(cheapestNextLevel(plans));

        this.bodyEl.replaceChildren();
        for (const build of [() => this._targetBar(plans), () => this._table(plans)]) {
            // One section that cannot be drawn must not take the other with it
            try {
                this.bodyEl.appendChild(build());
            } catch (error) {
                console.error('[AbilityBooks] A section could not be drawn:', error);
                const failed = this._note(`This section could not be drawn: ${error.message}`);
                failed.style.color = ROW_COLORS.bad;
                this.bodyEl.appendChild(failed);
            }
        }
    }

    /**
     * One target level for every ability, and what the lot would cost.
     * @param {Array<Object>} plans - From `abilityPlans`
     * @returns {HTMLElement}
     */
    _targetBar(plans) {
        const card = this._card();
        Object.assign(card.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });

        const label = this._label('Take everything to level');

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.value = sharedTarget === null ? '' : String(sharedTarget);
        input.placeholder = 'next';
        Object.assign(input.style, {
            width: '68px',
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 3px',
            textAlign: 'right',
        });
        input.addEventListener('change', () => {
            const parsed = Math.round(Number(input.value));
            sharedTarget = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
            // A level set for everything replaces the ones set one at a time,
            // or "everything" would quietly mean "everything else"
            abilityTargets.clear();
            this._render();
        });
        // A level typed here should not also be a game hotkey
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') input.blur();
            event.stopPropagation();
        });

        const totals = aimedTotals(plans);

        const summary = document.createElement('span');
        summary.append(
            this._value(`${formatWithSeparator(totals.books)} books`, ROW_COLORS.dim),
            document.createTextNode(' · '),
            this._value(formatKMB(totals.cost), ROW_COLORS.gold)
        );
        summary.title =
            'Every ability taken to the level its own row is aimed at.' +
            (plans.some((plan) => plan.shopPriced)
                ? ' Books the Tester shop sells cheaper are costed at the shop.'
                : '');
        // A total that quietly excludes rows is a lower bound wearing a total's
        // clothes, so the count of what it could not price is said out loud
        if (totals.unpriced) {
            const missing = this._value(` (+${totals.unpriced} unpriced)`, ROW_COLORS.bad);
            missing.title = 'Books with no market price, which cannot be included in the total.';
            summary.appendChild(missing);
        }

        card.append(label, input, summary);
        return card;
    }

    /**
     * @param {Array<Object>} plans - From `abilityPlans`
     * @returns {HTMLElement}
     */
    _table(plans) {
        const card = this._card();
        // No heading row. Five rows of six figures do not need labelling twice
        // over, and the labels were the widest thing in three of the columns —
        // the panel spent a line and a third of its type size saying "Books"
        // above a column of book counts. Each cell carries its own tooltip.
        card.title = 'Level · book · experience to go and the rate · time · books · cost · the level being aimed at.';

        if (!plans.length) {
            card.appendChild(this._note('No abilities learned yet.'));
            return card;
        }

        for (const plan of plans) card.appendChild(this._planRow(plan));
        return card;
    }

    /**
     * @param {Object} plan - One ability's plan
     * @returns {HTMLElement}
     */
    _planRow(plan) {
        const line = this._row();
        line.style.padding = '7px 0';

        // Every figure to the right of the level answers "to the target", and
        // the target is the next level until you say otherwise
        const aimed = plan.targetLevel !== null;
        const books = aimed ? plan.booksToTarget : plan.booksToNext;
        const cost = aimed ? plan.costToTarget : plan.costToNext;
        const owed = aimed ? plan.experienceToTarget : plan.experienceToNext;

        const level = this._cell(plan.level === 0 ? '—' : String(plan.level));
        Object.assign(level.style, {
            color: ROW_COLORS.gold,
            fontWeight: 'bold',
            fontSize: '17px',
            textAlign: 'center',
        });
        level.title = plan.level === 0 ? 'Not learned yet.' : `${plan.name} is level ${plan.level}.`;

        // Where the click goes, and which price the row is quoting: one
        // condition decides both, so the two cannot disagree
        const shop = plan.shopPriced;
        const where = shop ? 'Tester shop' : 'marketplace';

        // The icon is the name. An ability's book is its picture and a column of
        // pictures is read faster than a column of words — and the words were
        // ellipsed to "Pen…" at any width that left room for the figures.
        const icon = itemIcon(plan.itemHrid, 28);
        icon.style.justifySelf = 'center';
        linkToMarketplace(icon, plan.itemHrid, (itemHrid) => buyBooks(itemHrid, books));
        icon.style.opacity = plan.level === 0 ? '0.55' : '1';
        // An ability never learned reads differently from one at level 1, since
        // its first book buys the ability rather than a level
        icon.setAttribute(
            'title',
            (plan.level === 0
                ? `${plan.name} — not learned. The first book teaches the ability rather than levelling it.`
                : plan.name) +
                (books > 0
                    ? `\nClick to buy: opens the ${where} with ${formatWithSeparator(books)} filled in.`
                    : `\nClick to open in the ${where}.`)
        );

        line.append(level, icon, this._experienceCell(plan, owed), this._timeCell(plan, owed));

        const booksCell = this._cell(books === null ? '—' : formatWithSeparator(books));
        Object.assign(booksCell.style, { color: COLORS.books, fontWeight: 'bold', fontSize: '17px' });
        booksCell.title = `${plan.name}: ${books === null ? 'no' : formatWithSeparator(books)} books at ${formatWithSeparator(plan.perBookExperience)} experience each.`;

        const costCell = this._cell(cost === null ? 'no price' : formatKMB(cost));
        costCell.style.color = cost === null ? ROW_COLORS.bad : ROW_COLORS.gold;
        // A shop-floored figure is not a market quote and must not read as one.
        // The column has no room for the whole phrase the dictionary panel
        // prints, so it carries the same word and the tooltip says the rest
        if (cost !== null && shop) {
            const label = this._label(' shop');
            label.style.fontSize = '9px';
            costCell.appendChild(label);
        }
        costCell.title =
            cost === null
                ? 'Nobody is selling this book, so its cost is unknown rather than nothing.'
                : `${formatWithSeparator(books)} books at ${formatWithSeparator(plan.bookPrice)} each` +
                  (shop ? ', the Tester shop price, cheaper than the market.' : '.');

        line.append(booksCell, costCell, this._targetInput(plan));
        return line;
    }

    /**
     * Experience still owed, and how fast it is coming in.
     *
     * The rate below the figure rather than beside it, because the two are read
     * together — a number of experience means nothing until you know whether it
     * is an hour away or a fortnight.
     *
     * @param {Object} plan - One ability's plan
     * @param {number|null} owed - Experience to the target
     * @returns {HTMLElement}
     */
    _experienceCell(plan, owed) {
        const cell = document.createElement('span');
        Object.assign(cell.style, { whiteSpace: 'nowrap', lineHeight: '1.2', minWidth: '0' });

        const remaining = document.createElement('div');
        remaining.textContent = owed === null ? '—' : formatWithSeparator(Math.ceil(owed));
        Object.assign(remaining.style, { color: ROW_COLORS.good, fontSize: '14px' });
        remaining.title = 'Experience still owed to the level this row is aimed at.';

        const rate = document.createElement('div');
        rate.textContent = plan.experiencePerHour ? `${formatKMB(plan.experiencePerHour)}/hr` : '—/hr';
        Object.assign(rate.style, { color: COLORS.textDim, fontSize: '10px' });
        rate.title = rateTitle(plan);

        cell.append(remaining, rate);

        // On screen, not only in the tooltip: the window is what makes the
        // figure above it readable, and a caption nobody hovers is a caption
        // that does not exist
        if (plan.rateWindow) {
            const window = document.createElement('div');
            window.textContent = `over ${plan.rateWindow.days}d, ${plan.rateWindow.daysWithGain} w/ combat`;
            Object.assign(window.style, { color: COLORS.textDim, fontSize: '9px', opacity: '0.85' });
            window.title = rateTitle(plan);
            cell.append(window);
        }

        return cell;
    }

    /**
     * @param {Object} plan - One ability's plan
     * @param {number|null} owed - Experience to the target
     * @returns {HTMLElement}
     */
    _timeCell(plan, owed) {
        // Unmeasurable rather than infinite: an ability you are not training has
        // no arrival time, and "never" would be a claim about the future
        const seconds = plan.experiencePerHour && owed !== null ? (owed / plan.experiencePerHour) * 3600 : null;
        const cell = this._cell(seconds === null ? '—' : shortDuration(seconds));
        Object.assign(cell.style, {
            color: seconds === null ? COLORS.textDim : ROW_COLORS.accent,
            textAlign: 'center',
        });
        cell.title =
            seconds === null
                ? 'Needs a measured experience rate for this ability.'
                : plan.rateWindow
                  ? `At the rate ${rateWindowLabel(plan.rateWindow)}, idle days included.`
                  : 'At the current rate.';
        return cell;
    }

    /**
     * The level this ability is being taken to.
     * @param {Object} plan - One ability's plan
     * @returns {HTMLElement}
     */
    _targetInput(plan) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(plan.level + 1);
        input.max = '200';
        input.value = String(plan.targetLevel ?? plan.level + 1);
        input.dataset.ability = plan.abilityHrid;
        Object.assign(input.style, {
            width: '100%',
            background: 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '3px',
            color: COLORS.text,
            fontSize: '11px',
            padding: '2px 3px',
            textAlign: 'center',
        });
        input.addEventListener('change', () => {
            const parsed = Math.round(Number(input.value));
            // The next level is the resting state, not a target — storing it
            // would leave the row stuck at a level it is about to pass
            if (Number.isFinite(parsed) && parsed > plan.level + 1) abilityTargets.set(plan.abilityHrid, parsed);
            else abilityTargets.delete(plan.abilityHrid);
            this._render();
        });
        // A level typed here should not also be a game hotkey
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') input.blur();
            event.stopPropagation();
        });
        return input;
    }

    _card() {
        const card = document.createElement('div');
        Object.assign(card.style, {
            background: COLORS.card,
            border: `1px solid ${COLORS.hairline}`,
            borderRadius: '6px',
            padding: '7px 9px',
        });
        return card;
    }

    _row() {
        const line = document.createElement('div');
        Object.assign(line.style, {
            display: 'grid',
            gridTemplateColumns: '40px 34px minmax(0, 1fr) 84px 62px 78px 62px',
            gap: '6px',
            alignItems: 'center',
        });
        return line;
    }

    _cell(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        cell.style.textAlign = 'right';
        cell.style.whiteSpace = 'nowrap';
        return cell;
    }

    _left(text) {
        const cell = document.createElement('span');
        cell.textContent = text;
        return cell;
    }

    _label(text) {
        const label = document.createElement('span');
        label.textContent = text;
        label.style.color = COLORS.textDim;
        return label;
    }

    _value(text, color) {
        const value = document.createElement('span');
        value.textContent = text;
        if (color) value.style.color = color;
        return value;
    }

    _note(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.style.color = COLORS.textDim;
        return note;
    }

    _remove() {
        clearInterval(this.refreshId);
        this.refreshId = null;
        this.detachDrag?.();
        this.detachDrag = null;
        this.detachResize?.();
        this.detachResize = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;

        if (!this.panel) return;
        unregisterFloatingPanel(this.panel);
        this.panel.remove();
        this.panel = null;
        this.bodyEl = null;
    }
}

export const abilityBookPanel = new AbilityBookPanel();

// Module scope, like the overlay row that is currently its only signpost:
// the panel has no feature-registry lifecycle and no setting that switches
// it off, so there is no state in which it is imported but unavailable.
registerCommand({
    name: 'Ability Book',
    hint: 'What levelling each ability costs in books',
    run: () => abilityBookPanel.toggle(),
});

// A target level is a question about one character's abilities — taking main's
// Puncture from 41 to 100 is a different purchase from taking an ironcow's
// Puncture (same abilityHrid, level 3) to 100. `abilityTargets` is keyed on the
// hrid alone, so without this it survives a character switch and reapplies the
// departed character's targets to whoever switched in — silently, since every
// target here is still "valid" (target > new character's current level) until
// it happens not to be. The Combat Level panel resets its own per-character
// state the same way on the same event; this brings the ability panel in line.
// The same abilityHrid means the same key in `abilityHistory`, so an ironcow
// with more Puncture experience than main switching in reads as main gaining
// that whole gap between two samples — a rate in the tens of millions per
// hour that only self-heals once the departed character's reading falls out
// of the ten-minute window. The guard inside `skill-history.js` only catches
// experience going backwards (a lower-progress character switching in); it
// was never going to catch this direction.
//
// Cleared on `character_switching` rather than `character_switched`:
// `character_switched` is deliberately deferred (see data-manager.js), so
// `dataManager.characterData` is already the *arriving* character's by the
// time it fires. `abilityPlans()` is sampled by the networth row on its own
// timer independently of the panel, and a tick landing in that gap would read
// the new character's abilities against the old character's still-uncleared
// history — the exact bug this is fixing, just arriving a tick earlier.
// `character_switching` runs synchronously while `characterData` still
// belongs to the departing character, closing the gap entirely — the same
// fix the Combat Level panel already applies to its own history for the same
// reason.
dataManager.on('character_switching', () => abilityHistory.clear());

dataManager.on('character_switched', () => {
    resetAbilityTargets();
    if (abilityBookPanel.panel) abilityBookPanel._render();
});
