/**
 * Action panel layout
 *
 * Making the action detail modal fit on a screen.
 *
 * The game's panel was designed for the game's own contents: a name, the
 * inputs, the outputs and two buttons. This script adds most of a second
 * panel's worth on top — missing materials, a cost summary, a budget box,
 * action speed, level progress, the crafting plan, profitability — and the
 * modal grows to fit all of it. Past a certain recipe it grows taller than the
 * window, and what falls off the bottom is the **Start Now** button, which is
 * the one thing the panel exists to press.
 *
 * ## What this does
 *
 * Three things, all CSS:
 *
 * - **The modal stops growing at the height of the window** — the visible part
 *   of it, so the cap still holds with the mobile keyboard up. It is the panel
 *   that scrolls after that, not the page, so the close button and the title
 *   stay where they are instead of drifting off the top.
 * - **The buttons stick to the bottom of the panel.** They are the panel's
 *   verbs — queue this, start this — and having to scroll to reach a verb is
 *   the failure everything else here is downstream of. Position only: the strip
 *   is left the colour the game gives it.
 * - **The added sections are tightened.** Eight pixels above and below seven
 *   collapsible sections is over a hundred pixels of nothing, which is most of
 *   a section on its own.
 *
 * ## Why CSS and not layout code
 *
 * Everything here is the game's own markup, which changes when the game
 * changes. A stylesheet that stops matching leaves the panel exactly as it was
 * before; layout code that stops matching leaves it broken. `:has()` narrows
 * every modal rule to modals that actually contain an action panel, so nothing
 * here reaches the marketplace or the settings dialogs.
 */

import config from '../../core/config.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-action-panel-layout';

/** Room for the modal's own chrome — its padding and the close button */
const CHROME_PX = 96;

/**
 * The height to size against: the *visible* viewport, not the layout one.
 *
 * `100vh` and `window.innerHeight` do not shrink when the mobile on-screen
 * keyboard comes up, and this panel has two text inputs that bring it up — the
 * game's quantity field and the budget box this script adds
 * (`budget-calculator.js`). The buttons strip below is `position: sticky;
 * bottom: 0`, pinned to the bottom of whatever box these rules describe, so
 * sizing that box off the layout viewport puts Queue and Start underneath the
 * keyboard with nothing left to scroll to — the exact failure this file exists
 * to prevent, reintroduced by the keyboard. `--toolasha-visual-viewport-height`
 * (published on `<html>` by `src/utils/visual-viewport.js`) tracks the keyboard
 * as well as the address bar; `100vh` is the fallback for browsers without
 * `visualViewport`, which is what these rules said before.
 */
const VIEWPORT_HEIGHT = 'var(--toolasha-visual-viewport-height, 100vh)';

const CSS = `
    /* Only modals holding an action panel. The marketplace and the settings
       dialogs share these class names and want none of this. */
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"]) {
        max-height: calc(${VIEWPORT_HEIGHT} - 24px);
    }

    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"])
        [class*="Modal_modalContent"] {
        min-height: 0;
        overflow: hidden;
    }

    /* The panel is the scroller. Contained overscroll so reaching the bottom of
       it does not then start scrolling the page behind the modal.

       Horizontal overflow is hidden as a backstop only. The real cause was
       blocks built without box-sizing — a full-width card plus fourteen pixels
       of padding a side is a card wider than its column — and those are fixed
       where they are built rather than clipped here. */
    [class*="SkillActionDetail_skillActionDetail"] {
        max-height: calc(${VIEWPORT_HEIGHT} - ${CHROME_PX}px);
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        /* Reserve the gutter whether or not the bar is showing. Without it the
           vertical scrollbar appears *after* the layout has been worked out and
           takes its width out of the column, so every row that was exactly as
           wide as the column is now wider than it — which is a horizontal
           scrollbar, caused by the vertical one. */
        scrollbar-gutter: stable;
    }

    /* The scrollbar is left as the game draws it. Recolouring it was chasing
       the wrong thing anyway: the horizontal bar was never a styling problem
       but a width one, fixed where the oversized blocks are built. */

    /* So is the buttons strip. Pinning it needed no colour of its own, and
       three rounds of "there is a box round the buttons" were all this script
       painting one: first a themed variable that came out blue, then a dark
       literal that came out black — a filled band across the foot of every
       skilling action panel, sat directly under the last row of content. The
       strip is positioned here and nothing more; whatever the game puts behind
       the buttons is what shows. */

    /* The containers between the modal and the panel scroll nothing of their
       own — the panel is the scroller — so any bar they show is the same
       artefact one level up */
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"]),
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"])
        [class*="Modal_modalContent"],
    [class*="Modal_modal__"]:has([class*="SkillActionDetail_skillActionDetail"])
        [class*="SkillActionDetail_content"] {
        overflow-x: hidden;
    }

    /* Nothing inside the panel may be wider than the panel — at any depth, not
       just the rows sitting directly in it. The Cost Summary card is inserted
       beside the item requirements rather than at the top level, so a rule for
       direct children walked straight past it.

       The panel is a column of rows. A row wider than its column is always the
       bug rather than the intent, so this is safe to state once for everything
       rather than hunted one element at a time. */
    [class*="SkillActionDetail_skillActionDetail"] * {
        max-width: 100%;
        box-sizing: border-box;
    }

    /* The actual overflow, and it was never one of the blocks.

       The panel's body is a two-column grid — a label like "Requires" beside a
       value — and everything this script adds goes into the value column. A
       grid item defaults to a minimum width of auto, which means it refuses to be
       narrower than its own longest unbreakable content. So the column takes
       whatever "Missing Mats Marketplace" and "Direct recipe cost   5.7M" ask
       for, the grid becomes wider than the panel, and the panel scrolls
       sideways. Every block inside measures exactly the column's width, which
       is why they all looked innocent: they were sized correctly, to a column
       that was itself too wide.

       Allowing those items to shrink is what lets the grid fit its panel. */
    [class*="SkillActionDetail_skillActionDetail"],
    [class*="SkillActionDetail_skillActionDetail"] [class*="SkillActionDetail_info"],
    [class*="SkillActionDetail_skillActionDetail"] [class*="SkillActionDetail_value"],
    [class*="SkillActionDetail_skillActionDetail"] [class*="SkillActionDetail_content"],
    [class*="SkillActionDetail_skillActionDetail"] > * {
        min-width: 0;
    }

    /* Queue and Start, always reachable. Sticky rather than fixed so it belongs
       to the panel and moves with a dragged modal.

       Position and nothing else — see above for why this strip paints no
       background and draws no line of its own. */
    [class*="SkillActionDetail_skillActionDetail"] [class*="SkillActionDetail_buttonsContainer"] {
        position: sticky;
        bottom: 0;
        z-index: 2;
        margin-top: 4px;
        /* The container measures a fraction of a pixel wider than the panel it
           sits in — 321.883 against 320 — which is enough overflow to summon a
           horizontal scrollbar across the bottom of the panel. Clipping the
           panel alone does not help while the child is still asking for width
           it cannot have. */
        max-width: 100%;
        box-sizing: border-box;
    }

    /* Ours, tightened. Seven sections at eight pixels a side is a section's
       worth of empty space. */
    [class*="SkillActionDetail_skillActionDetail"] .mwi-collapsible-section {
        margin-top: 2px;
        margin-bottom: 2px;
    }
    [class*="SkillActionDetail_skillActionDetail"] .mwi-section-header {
        padding: 1px 0;
    }
    [class*="SkillActionDetail_skillActionDetail"] #mwi-missing-mats-button {
        margin: 4px 0 6px 0;
        padding: 6px 12px;
    }
`;

const actionPanelLayout = {
    initialize() {
        if (!config.getSetting('actionPanelLayout')) return;
        addStyles(CSS, STYLE_ID);
    },

    disable() {
        removeStyles(STYLE_ID);
    },

    cleanup() {
        removeStyles(STYLE_ID);
    },
};

export default actionPanelLayout;
