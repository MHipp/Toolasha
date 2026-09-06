/** @vitest-environment happy-dom */
/**
 * Coverage for a zero baseline in the Equipment Progression panel.
 *
 * `_computeSlotMetrics` and `_makeGainEl` both used to guard on `baseline > 0` before showing
 * or scoring any gain. That guard conflates two different situations: "no gain" (delta <= 0)
 * and "no rate to compare against" (baseline === 0). The second is real for a gold-goal
 * gathering skill whose unequipped actions are entirely unpriced — `scoreEquipmentSetup` skips
 * every zero-or-negative-score action and divides by the survivor count, so an all-unpriced
 * empty slot scores exactly 0 gold/hr. An item that unlocks even one priced drop then has a
 * genuine, large gain over that baseline, but the old guard reported it as a flat 0% both on
 * the rendered row (no gain span at all) and in the goldGain/value sort keys (scored identically
 * to a row with no gain whatsoever) — silently burying what may be the best upgrade on the board.
 *
 * Like skilling-optimizer-ui.cost-payback.test.js, this exercises the plain instance methods
 * directly against happy-dom rather than standing up the whole panel.
 */
import { describe, test, expect, vi } from 'vitest';

// _computeSlotMetrics also prices the upgrade via calculateSlotUpgradeCost, which reaches
// dataManager/gameData — irrelevant to the xpPct/goldPct math this file is about, and unavailable
// in this plain (non-happy-dom-game) test setup. Stub it out like skilling-optimizer-ui.sort.test.js
// does, rather than dragging in the real item-pricing chain.
vi.mock('./skilling-optimizer-engine.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, calculateSlotUpgradeCost: () => null };
});

const { skillingSimulatorUI: ui } = await import('./skilling-optimizer-ui.js');

describe('_makeGainEl against a zero baseline', () => {
    test('a real XP gain from a zero baseline is shown, marked "new" instead of a percentage', () => {
        const el = ui._makeGainEl(500, 0, 0, 0, null);
        expect(el).not.toBeNull();
        expect(el.textContent).toContain('+500 XP');
        expect(el.textContent).toContain('(new)');
        expect(el.textContent).not.toContain('NaN');
        expect(el.textContent).not.toContain('Infinity');
    });

    test('a real Gold gain from a zero baseline is shown, marked "new" instead of a percentage', () => {
        const el = ui._makeGainEl(0, 0, 500, 0, null);
        expect(el).not.toBeNull();
        expect(el.textContent).toContain('+500');
        expect(el.textContent).toContain('(new)');
        expect(el.textContent).not.toContain('NaN');
        expect(el.textContent).not.toContain('Infinity');
    });

    test('no gain at all against a zero baseline still renders nothing', () => {
        expect(ui._makeGainEl(0, 0, 0, 0, null)).toBeNull();
    });

    test('a real gain against a positive baseline still shows its actual percentage', () => {
        const el = ui._makeGainEl(1100, 1000, 0, 0, null);
        expect(el.textContent).toContain('+100 XP');
        expect(el.textContent).toContain('(+10.0%)');
        expect(el.textContent).not.toContain('(new)');
    });
});

describe('_computeSlotMetrics against a zero baseline', () => {
    /**
     * One slot whose single progression entry scores the stated xp/gold.
     * @param {number} xpScore
     * @param {number} goldScore
     * @returns {Object} slotData, as optimizeSkill() returns one entry of `slots`
     */
    const slotData = (xpScore, goldScore) => ({
        progression: [{ itemHrid: '/items/x', breakpoint: 0, enhancementLevel: 0, xpScore, goldScore }],
    });

    test('a real gold gain from a zero baseline scores Infinity, not 0', () => {
        const metrics = ui._computeSlotMetrics(slotData(0, 500), null, 0, 0);
        expect(metrics.entry).not.toBeNull();
        expect(metrics.goldPct).toBe(Infinity);
        expect(metrics.xpPct).toBe(0); // xp axis truly has no gain here
    });

    test('a real xp gain from a zero baseline scores Infinity, not 0', () => {
        const metrics = ui._computeSlotMetrics(slotData(500, 0), null, 0, 0);
        expect(metrics.xpPct).toBe(Infinity);
        expect(metrics.goldPct).toBe(0);
    });

    test('a positive baseline still yields an ordinary finite percentage', () => {
        const metrics = ui._computeSlotMetrics(slotData(1100, 1100), null, 1000, 1000);
        expect(metrics.xpPct).toBe(10);
        expect(metrics.goldPct).toBe(10);
    });

    test('goldGain sort ranks a zero-baseline gain above a merely large percentage gain', () => {
        const fromZero = { index: 0, metrics: ui._computeSlotMetrics(slotData(0, 500), null, 0, 0) };
        const bigPct = { index: 1, metrics: ui._computeSlotMetrics(slotData(0, 2000), null, 0, 1000) };
        // Before the fix, fromZero's goldPct was 0 — indistinguishable from a slot with no gain
        // at all, and it sorted after bigPct (and after a real no-gain row) purely by index.
        expect(ui._compareSlotViews(fromZero, bigPct, 'gold', 'goldGain')).toBeLessThan(0);
    });

    test('a zero panel baseline ranks its rows by the size of the gain, not by slot order', () => {
        // The baseline belongs to the panel, so when it is zero every row's percentage is
        // Infinity at once. Without a secondary key the whole list ties and falls to slot
        // order, which puts a 10 gold/hr upgrade above a 5,000 gold/hr one for no reason.
        const small = { index: 0, metrics: ui._computeSlotMetrics(slotData(0, 10), null, 0, 0) };
        const large = { index: 1, metrics: ui._computeSlotMetrics(slotData(0, 5000), null, 0, 0) };
        expect(small.metrics.goldPct).toBe(Infinity);
        expect(large.metrics.goldPct).toBe(Infinity);
        expect(ui._compareSlotViews(large, small, 'gold', 'goldGain')).toBeLessThan(0);
        expect(ui._compareSlotViews(small, large, 'gold', 'goldGain')).toBeGreaterThan(0);
    });

    test('an xp panel with a zero baseline ranks by the size of the xp gain too', () => {
        const small = { index: 0, metrics: ui._computeSlotMetrics(slotData(10, 0), null, 0, 0) };
        const large = { index: 1, metrics: ui._computeSlotMetrics(slotData(5000, 0), null, 0, 0) };
        expect(ui._compareSlotViews(large, small, 'xp', 'xpGain')).toBeLessThan(0);
    });

    test('modes that are not gain modes keep slot order as their tiebreak', () => {
        const a = { index: 0, metrics: ui._computeSlotMetrics(slotData(0, 500), null, 0, 0) };
        const b = { index: 1, metrics: ui._computeSlotMetrics(slotData(0, 900), null, 0, 0) };
        // Both unpriceable, so 'cost' ties at Infinity; the bigger gain must NOT jump the queue
        // in a mode that says nothing about gain.
        expect(ui._compareSlotViews(a, b, 'gold', 'cost')).toBeLessThan(0);
    });
});
