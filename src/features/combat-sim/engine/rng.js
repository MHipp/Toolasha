// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Seeded RNG for the combat simulator.
 *
 * The engine draws random numbers constantly — spawn composition, hit and crit
 * rolls, parry, threat targeting, stun chance, proc chances. Left unseeded, two
 * sims of the same setup are independent samples, so an upgrade comparison
 * measures the upgrade's effect *plus* the gap between two random draws. That's
 * why sub-0.1% deltas flip sign between runs.
 *
 * Seeding both sims from one value gives them common random numbers: the shared
 * part of the stream cancels out of the difference and only the upgrade's real
 * effect is left. Draws are split into independent streams by purpose so a
 * player-side change can't shift monster-side draws — both sims walk the same
 * spawn sequence even after their combat rolls have diverged.
 *
 * With no seed set every draw falls through to Math.random(), which is the
 * previous behavior, so paths that want a fresh sample per run are untouched.
 */

/** Odd 32-bit constant (2^32 / golden ratio) used to space stream seeds apart. */
const STREAM_STRIDE = 0x9e3779b9;

/**
 * mulberry32 — 32-bit counter-based PRNG. Small state, no dependencies,
 * uniform enough for Monte Carlo work, period 2^32.
 * @param {number} seed - Any 32-bit integer
 * @returns {Function} Draw function returning [0, 1)
 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return function draw() {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Mix a seed with an index into a well-separated 32-bit seed (murmur3 finalizer).
 * @param {number} seed - Base seed
 * @param {number} index - Stream or chunk index
 * @returns {number} Derived 32-bit seed
 */
function mixSeed(seed, index) {
    let h = (seed ^ Math.imul(index + 1, STREAM_STRIDE)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
}

/** Combat rolls: hits, crits, damage, procs, targeting. Desyncs as soon as loadouts differ. */
let combatDraw = null;

/**
 * Monster spawn composition only. Kept free of any player-dependent draw so the
 * encounter sequence is identical across sims of the same seed.
 */
let spawnDraw = null;

/** Per-encounter monster setup (starting ability cooldown offsets). */
let setupDraw = null;

/** Base seed, kept so the per-encounter streams can be re-derived mid-run. */
let baseSeed = null;

/**
 * Normalize a seed input to a 32-bit integer.
 * @param {*} seed
 * @returns {number|null} 32-bit seed, or null if not a usable number
 */
function normalizeSeed(seed) {
    if (seed === null || seed === undefined || seed === '') return null;
    const numeric = Number(seed);
    if (!Number.isFinite(numeric)) return null;
    return Math.floor(Math.abs(numeric)) >>> 0;
}

/**
 * Seed every simulation stream from one value. Two sims given the same seed draw
 * the same numbers in the same order until their flow diverges.
 * @param {number|null} seed - Seed, or null/undefined to run unseeded
 * @returns {boolean} True if seeded, false if left on Math.random()
 */
export function seedSimRng(seed) {
    const base = normalizeSeed(seed);
    if (base === null) {
        clearSimRng();
        return false;
    }

    baseSeed = base;
    combatDraw = mulberry32(mixSeed(base, 0));
    spawnDraw = mulberry32(mixSeed(base, 1));
    setupDraw = mulberry32(mixSeed(base, 2));
    return true;
}

/**
 * Re-derive the combat and setup streams for the start of an encounter.
 *
 * Without this, the streams desync the moment the two sims take a different
 * number of draws — a stronger loadout needs fewer swings — and everything after
 * that point is back to being an independent sample. Restarting those streams
 * each encounter caps the damage: encounter N begins from the same random state
 * in both runs no matter what happened in encounter N-1. The spawn stream is
 * deliberately left running so the monster sequence keeps advancing in order.
 *
 * No-op while unseeded.
 * @param {number} encounterIndex - Zero-based encounter counter for this run
 * @returns {boolean} True if the streams were re-derived
 */
export function syncEncounterRng(encounterIndex) {
    if (baseSeed === null) return false;

    const slot = 0x10000 + encounterIndex * 2;
    combatDraw = mulberry32(mixSeed(baseSeed, slot));
    setupDraw = mulberry32(mixSeed(baseSeed, slot + 1));
    return true;
}

/** Drop back to Math.random() for every stream. */
export function clearSimRng() {
    baseSeed = null;
    combatDraw = null;
    spawnDraw = null;
    setupDraw = null;
}

/** @returns {boolean} True while a seed is active */
export function isSimRngSeeded() {
    return combatDraw !== null;
}

/**
 * Combat roll. Falls through to Math.random() when unseeded.
 * @returns {number} [0, 1)
 */
export function random() {
    return combatDraw ? combatDraw() : Math.random();
}

/**
 * Spawn-composition roll. Falls through to Math.random() when unseeded.
 * @returns {number} [0, 1)
 */
export function randomSpawn() {
    return spawnDraw ? spawnDraw() : Math.random();
}

/**
 * Monster-setup roll. Falls through to Math.random() when unseeded.
 * @returns {number} [0, 1)
 */
export function randomSetup() {
    return setupDraw ? setupDraw() : Math.random();
}

/**
 * Derive a distinct sub-seed from a base seed and an index — for the chunks of a
 * split simulation, or for the separate sims of one analysis (per fight, per
 * zone). Sub-run N must not replay sub-run M, but sub-run N of two compared
 * analyses must match, so the derivation is deterministic in (seed, index).
 * @param {number|null} seed - Base seed
 * @param {number} index - Zero-based sub-run index
 * @returns {number|null} Derived seed, or null when there is no base seed
 */
export function deriveSeed(seed, index) {
    const base = normalizeSeed(seed);
    if (base === null) return null;
    return mixSeed(base, 0x100 + index);
}

/**
 * Fresh random base seed for one analysis run. Held constant across that run's
 * baseline and candidate sims; different on the next run, so repeating an
 * analysis still resamples instead of reprinting the same numbers.
 * @returns {number} 31-bit seed
 */
export function randomSeed() {
    return Math.floor(Math.random() * 0x7fffffff);
}

/**
 * An independent seeded draw function, detached from the module-level streams.
 *
 * The streams above are global state shared by whatever sim is running. A
 * caller outside the engine — a Monte Carlo projection on the net worth panel,
 * say — needs reproducibility without reseeding combat mid-run, so it takes its
 * own generator instead.
 * @param {number|null} seed - Seed; null/unusable falls back to Math.random()
 * @returns {Function} Draw function returning [0, 1)
 */
export function createSeededDraw(seed) {
    const base = normalizeSeed(seed);
    if (base === null) return Math.random;
    return mulberry32(mixSeed(base, 3));
}
