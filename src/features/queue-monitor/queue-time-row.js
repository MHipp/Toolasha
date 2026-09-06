/**
 * Queue Time Left overlay row
 *
 * How long before this character runs out of things to do.
 *
 * The queue monitor already answers this question, but only about the
 * characters you are *not* playing — its whole design is a snapshot taken as a
 * character is switched away from, because that is the only moment their skills
 * and equipment are still live. The character in front of you has no snapshot
 * and needs none: everything the estimate wants is loaded right now.
 *
 * So this is the same arithmetic against live data rather than against a stored
 * reading, and it is deliberately its own function rather than a call into
 * `queue-snapshot.js`. That module's copy runs once, inside a
 * `character_switching` handler, over a character who is halfway out of the
 * door; this one runs on the overlay's tick and has to be cheap and reentrant.
 * They agree on the formula — remaining count over the efficiency multiplier,
 * times the action's time — and `utils/efficiency.js` owns the multiplier so
 * the agreement is not two hand-written copies of it.
 *
 * ## Why there is nothing to open
 *
 * `onOpen` is a promise that a panel behind the tile answers the same question
 * in more detail, and the queue monitor's panel does not: it lists other
 * characters and has no view of this one. A tile that opened it would be a tile
 * that answers a double-click with somebody else's queue, which is worse than a
 * tile that does not respond at all.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { calculateEfficiencyMultiplier } from '../../utils/efficiency.js';
import { runningAction } from '../../utils/combat-actions.js';

/**
 * What is left of the current character's action queue.
 *
 * An infinite action is reported rather than counted: it never empties, so a
 * total that silently skipped it would say "12m" about a queue that will still
 * be running tomorrow. Everything queued *behind* an infinite action is in the
 * same position, but it is still counted — the figure is then the time to reach
 * the infinite action, which is the honest reading of "when does the queue
 * change".
 *
 * @returns {{seconds: number, finite: number, queued: number, infinite: boolean}|null}
 *   Null when the game has not loaded enough to say anything
 */
export function queueTimeLeft() {
    const actions = dataManager.getCurrentActions?.();
    const skills = dataManager.getSkills?.();
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap;
    if (!actions || !skills || !itemDetailMap) return null;

    const equipment = dataManager.getEquipment?.();
    let seconds = 0;
    let finite = 0;
    let queued = 0;
    let infinite = false;

    // The queue array is insertion order, not execution order — a repeating action
    // requeued to the front after completing a cycle keeps a *higher* ordinal, so the
    // action actually running is the lowest-ordinal unfinished one, not actions[0] or the
    // first non-done entry a `for…of` happens to reach. Needed here only to know which
    // single finite action, if any, has already burned part of its current unit.
    const current = runningAction(actions);

    for (const action of actions) {
        if (action?.isDone) continue;
        queued += 1;

        if (!action.hasMaxCount) {
            infinite = true;
            continue;
        }

        const details = dataManager.getActionDetails?.(action.actionHrid);
        if (!details) continue;

        const stats = calculateActionStats(details, {
            skills,
            equipment,
            itemDetailMap,
            actionHrid: action.actionHrid,
            includeCommunityBuff: true,
        });
        if (!stats) continue;

        const remaining = Math.max(0, (action.maxCount || 0) - (action.currentCount || 0));
        // Whole actions only — a character cannot run 6.4 actions to finish the
        // last few items, they run 7 and the queue takes the full 7th action's
        // time. `queue-snapshot.js` rounds up for exactly this reason; skipping
        // it here quietly undercounts every action whose efficiency does not
        // divide the remaining count evenly.
        const effectiveRate = calculateEfficiencyMultiplier(stats.totalEfficiency);
        let actionSeconds = Math.ceil(remaining / effectiveRate) * stats.actionTime;

        // The running action's current unit is already partway done; charging it in full
        // overestimates the tile by up to one whole action's duration for as long as that
        // unit is in progress. Scoped to (id, currentCount) so a queued action — which has
        // no boundary recorded for it — is never affected.
        if (action === current) {
            const elapsed = dataManager.getElapsedSecondsInCurrentUnit(action.id, action.currentCount, stats.actionTime);
            actionSeconds = Math.max(0, actionSeconds - elapsed);
        }

        seconds += actionSeconds;
        finite += 1;
    }

    return { seconds, finite, queued, infinite };
}

registerRow({
    key: 'queueTimeLeft',
    name: 'Queue Time Left',
    empty: 'Nothing queued',
    // Off by default: it is only news for a player who queues finite batches,
    // and for everyone else it is a permanent ∞
    defaultVisible: false,
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const left = queueTimeLeft();
        if (!left || !left.queued) return blank(container);

        // An infinite action with nothing costed in front of it has no duration
        // to give, and a zero would read as "about to stop"
        const unbounded = left.infinite && left.finite === 0;

        row(container, [
            // Named rather than given a glyph: the overlay has no symbol that
            // means "queue", and a borrowed one would collide with a tile that
            // owns it
            { text: 'Queue', color: ROW_COLORS.dim, ellipsis: true },
            {
                text: unbounded ? '∞' : shortDuration(left.seconds),
                color: unbounded ? ROW_COLORS.dim : ROW_COLORS.accent,
                bold: true,
                push: true,
            },
        ]);

        container.title =
            (unbounded
                ? 'The action running now has no count, so the queue never empties.'
                : `About ${shortDuration(left.seconds)} until the queue empties, ` +
                  `across ${left.finite} counted action${left.finite === 1 ? '' : 's'}.`) +
            (left.infinite && left.finite > 0
                ? '\nAn action with no count is queued, so this is time until that.'
                : '') +
            '\nOther characters are in the queue monitor panel.';
    },
});
