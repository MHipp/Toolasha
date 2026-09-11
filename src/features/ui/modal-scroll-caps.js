/**
 * Modal scroll caps
 *
 * Firefox alone lets three of the game's own dialogs grow past their frame.
 *
 * ## The divergence
 *
 * Several game dialogs are built as a container > frame > scroller triplet:
 * the frame is `display: grid; grid-template-rows: 100%; max-height: 96%` (or
 * `98%`), with no `height` of its own, and the scroller inside it is
 * `overflow: auto`. Chromium and WebKit re-resolve that `100%` grid row
 * against the frame's own max-height-clamped size, so the scroller is stuck
 * inside the frame no matter how tall its content gets. Firefox sizes the row
 * to the scroller's *content* instead, so once the content is taller than the
 * frame, the scroller — and whatever sits at its bottom — hangs past the
 * frame with no way to reach it. `house-cost-display.js`'s `SCROLLER_MAX_HEIGHT`
 * fixed this for the house upgrade dialog by restating the frame's own limit
 * directly on the scroller; this file does the same for three more dialogs
 * measured to have the same problem in Firefox 155 against the game's real
 * stylesheet:
 *
 * - **Offline progress / welcome back** — the item and XP lists have no
 *   height limit of their own, so after a long time offline the bottom of the
 *   dialog is unreachable on both desktop and phones.
 * - **Item Dictionary** — a generic `Modal_modal` dialog whose content the
 *   game caps at a fixed `46.875rem` with no `overflow`; on a 640px-tall
 *   phone the scroller hangs roughly 55px past the frame.
 * - **Shareable profile** — marginal: the header above its fixed-height tab
 *   strip can push a small phone slightly past the frame.
 *
 * The Marketplace window was measured safe (it sets an explicit `height`) and
 * is deliberately left alone, as are the action panel and the house dialog —
 * both already have their own rules in `action-panel-layout.js` and
 * `house-cost-display.js`.
 *
 * ## Why a `max-height`, not a layout fix
 *
 * Every rule here only ever *lowers* a ceiling the game already draws below,
 * so a dialog whose content already fits — most of the time, for all three —
 * never reaches it and renders exactly as the game intended. There is nothing
 * to undo on Chromium or WebKit: the same cap sits a couple of pixels inside
 * where their own grid resolution already put the scroller.
 *
 * The first two dialogs (`OfflineProgressModal_modalContent`,
 * `SharableProfile_modalContent`) carry compound class names unique to that
 * one dialog, so the selector needs no `:has()` to stay scoped — a
 * substring match on either can only ever hit its own dialog. The Item
 * Dictionary is different: it renders inside the *generic* `Modal_modal` /
 * `Modal_modalContent` wrapper the marketplace and every settings dialog also
 * use, so its rule is `:has()`-gated on `ItemDictionary_modalContent` the
 * same way `action-panel-layout.js` gates its rules on
 * `SkillActionDetail_skillActionDetail` — nothing else in the game nests that
 * class inside `Modal_modalContent`. A browser without `:has()` just drops
 * that one rule and keeps today's behaviour; unlike the house dialog, nothing
 * here has a Build button that would be left broken by the drop, so there is
 * no inline fallback to carry it.
 */

import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-modal-scroll-caps';

/**
 * The height to size against: the *visible* viewport, not the layout one —
 * same reasoning and the same variable as `action-panel-layout.js` and
 * `house-cost-display.js`, so these caps track the mobile on-screen keyboard
 * and the address bar instead of missing them the way `vh` does.
 */
const VIEWPORT_HEIGHT = 'var(--toolasha-visual-viewport-height, 100vh)';

/** Mirrors `OfflineProgressModal_modal` / `SharableProfile_modal`'s own `max-height: 98%` and 1px top+bottom border. */
const DIALOG_MAX_HEIGHT = `calc(${VIEWPORT_HEIGHT} * 0.98 - 2px)`;

/** Mirrors the generic `Modal_modal` frame's `max-height: 96%` and 1px top+bottom border. */
const GENERIC_MODAL_MAX_HEIGHT = `calc(${VIEWPORT_HEIGHT} * 0.96 - 2px)`;

const CSS = `
    [class*="OfflineProgressModal_modalContent"] {
        box-sizing: border-box;
        max-height: ${DIALOG_MAX_HEIGHT};
    }

    [class*="SharableProfile_modalContent"] {
        box-sizing: border-box;
        max-height: ${DIALOG_MAX_HEIGHT};
    }

    /* Generic Modal_modal wrapper: gated to the Item Dictionary only, the same
       way action-panel-layout.js gates its Modal_modal rules — otherwise this
       would reach the marketplace and every settings dialog too. */
    [class*="Modal_modalContent"]:has([class*="ItemDictionary_modalContent"]) {
        box-sizing: border-box;
        max-height: ${GENERIC_MODAL_MAX_HEIGHT};
    }
`;

const modalScrollCaps = {
    initialize() {
        addStyles(CSS, STYLE_ID);
    },

    disable() {
        removeStyles(STYLE_ID);
    },

    cleanup() {
        removeStyles(STYLE_ID);
    },
};

export default modalScrollCaps;
