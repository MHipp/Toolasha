/**
 * Player-attribution helpers
 *
 * A recorded combat run's `players` array holds everybody in the party, and
 * the current character is marked with `isCurrentPlayer`. Snapshots archived
 * before that flag existed carry no such marker, and three call sites used to
 * paper over that gap with `players.find(isCurrentPlayer) || players[0]` —
 * which silently credits this character with slot 0's loot, drops, or ROI
 * whenever a *party* run happens to be unflagged. Slot 0 is party order, not
 * identity, so that fallback is a guess dressed up as a read.
 *
 * The rule: the flagged player; else, only when the run has exactly one
 * player, that player (an unflagged solo run has exactly one honest answer);
 * else null. A caller getting null must treat the run as contributing
 * nothing for this character — never fall back to guessing who else it might
 * be.
 *
 * Stateless by design — it is bundled into more than one feature bundle (see
 * the allowlist in scripts/check-bundle-sharing.mjs) and every copy must
 * agree.
 */

/**
 * Which player in a recorded run is this character.
 *
 * @param {Array<{isCurrentPlayer?: boolean}>} players - A run's player list
 *   (e.g. an archived combat session's `players`, or a live party snapshot's).
 * @returns {Object|null} The flagged player; the only player, when the run is
 *   unflagged and solo; otherwise null — an unflagged party run cannot be
 *   attributed to any one of its members.
 */
export function ownPlayer(players) {
    const list = Array.isArray(players) ? players : [];
    const flagged = list.find((player) => player?.isCurrentPlayer);
    if (flagged) return flagged;
    return list.length === 1 ? list[0] : null;
}
