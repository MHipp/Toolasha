# MWITools (adaptation notes)

Notes on **MWITools v26.4.17** by **bot7420, shykai and Stella** — the long-running
general-purpose toolkit for Milky Way Idle, CC-BY-NC-SA-4.0, published as GreasyFork script
494467:

<https://greasyfork.org/en/scripts/494467-mwitools>

The script is **not kept here**; see `LICENSE.md` beside this file for the licence it declares
and for the statement that portions were adapted and modified. What follows is the record of
which portions, what Toolasha does with them, and where.

## What was adapted

- **The `market_item_values_updated` subscription.** MWITools routes that WebSocket message to
  an `applyMarketItemValues` handler that swaps `marketValuesVersion` and `marketItemValues`
  wholesale and marks its valuation caches dirty. Toolasha read the same map only out of
  localStorage through the game's own util, on a 30-second throttle, so a mid-session value
  refresh left every consumer of the official values — networth's `officialValue` source, the
  tradable-band clamp — up to that long stale, and stale for the whole session if the game
  writes the blob only once. The message is now handled in `src/core/data-manager.js` and
  applied in `src/utils/market-values.js`, which swaps the cached map, bumps the cached version
  and drops the derived band cache. Toolasha's own structure otherwise: its cache, its
  band derivation, its event bus. What was taken is the knowledge that the message exists and
  the shape of its payload.
- **The header anchor selectors.** MWITools anchors a header warning against
  `div[class*="Header_actionInfo"]` and measures around `div[class*="Header_communityBuffs"]`.
  Neither appeared anywhere in Toolasha. Both are now in the canary selector list in
  `src/entrypoint.js`, so a game refactor of the header is reported through
  `UI.healthStatus.reportFailures` like every other anchor Toolasha depends on. Taken: the two
  selector strings. Everything around them is Toolasha's existing canary machinery.
- **Locale-aware thousands/decimal separator detection.** MWITools derives the game's number
  separators from `Intl.NumberFormat(locale).formatToParts(1111.1)`, with the locale taken from
  the game's own `i18nextLng` localStorage key rather than from the browser — the game's
  language setting and the browser's need not agree, and the game formats its numbers by the
  former. Toolasha had been stripping separators with a hardcoded `replace(/,/g, '')`, which
  silently mis-parses every comma-decimal locale (`1,5` reads back as 15). The detection is
  adapted in `parseGameNumber` / `gameNumberSeparators` in `src/utils/number-parser.js`, with an
  attribution line in the JSDoc; the parsing built on top of it, and the call sites, are
  Toolasha's. `formatters.js` was the obvious home but the wrong one: `number-parser.js`
  already exists for exactly this — reading a number back out of text the game drew — and
  `parseGameNumber` is the locale-driven sibling of the `parseItemCount` heuristic there.

- **The ability→effect index and the buff/debuff bars.** MWITools' `battleBuffs` builds an
  index at boot of which buffs and debuffs each ability applies and to whom, seeds per-unit
  state from the combatant list on `new_battle`, and reconciles it against the buff maps on
  `battle_updated`, drawing an icon strip with countdowns beneath every unit. Toolasha's version
  is `src/utils/ability-effects.js` (the index, identity-cached like its other boot-time
  indexes) and `src/features/combat/combat-unit-buff-bars.js` (the strips, seated in the unit
  tile the way `portrait-dps.js` already does). Two deliberate departures: buff-versus-debuff
  is decided by the effect's target, not its type, because a debuff arrives as a damage effect
  whose buffs land on the target; and MWITools' HP-delta inference of pending effects was not
  taken, since it would paint a debuff on a monster that resisted. Setting `combatUnitBuffBars`.
- **The equipment mismatch warning.** MWITools' `checkEquipment` shows a header pill when
  skilling gear is worn into combat or a production action runs while its efficiency piece sits
  unequipped, checking four pieces against their action families and suppressing itself during
  a labyrinth run. Toolasha's `src/features/equipment/equipment-mismatch-warning.js` keeps the
  four rules but verifies each against the item's own `equipmentDetail` at runtime and skips a
  rule the data does not confirm — which is how the enchanted gloves' enhancing bonus turned out
  to be speed, not efficiency. The running action comes from `runningAction()`, never from the
  queue's first entry. Setting `equipmentMismatchWarning`.

## What was not adapted

- **MWITools' own market API.** Its value handling sits beside a fetch of a third-party market
  price API with its own caching, fallback host and local backup blob. Toolasha prices from the
  game's own order books and official values and does not fetch an external price feed.
- **Its config and settings model.** The separator detection was taken out of MWITools' config
  module; the settings map it lives in, and the script-wide `isZH` language switch beside it,
  were not.
