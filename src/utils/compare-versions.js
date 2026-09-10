/**
 * Ordering for dotted version strings.
 *
 * Its own module because two unrelated things need it — the update check, which
 * asks whether GitHub has something newer, and the what's-new changelog filter,
 * which asks which entries a player has already seen — and neither should have
 * to import the other's transport, toasts and timers to get it.
 */

/**
 * Compare two dotted version strings numerically.
 *
 * Numerically, because the strings do not sort: `3.9.0` is older than `3.10.0`
 * and string comparison says the opposite. A missing component reads as zero,
 * so `3.10` and `3.10.0` are the same version.
 * @param {string} a - One version, e.g. `3.17.0`
 * @param {string} b - Another
 * @returns {number} Negative when a < b, positive when a > b, 0 when equal
 */
export function compareVersions(a, b) {
    const left = String(a).split('.').map(Number);
    const right = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff) return diff;
    }
    return 0;
}
