/**
 * The small floating control panel three walks share.
 *
 * The Bulk Sell Assistant grew one first: a fixed, draggable strip carrying a
 * status line, one main button whose label is always the next thing a press
 * would do, a ⚙ that folds out the rules the walk decides by, and a ✕. It
 * turned out to be the right shape for every guided walk in the script — the
 * reroll walk and the Consumables Buy-all want exactly the same strip — and
 * three hand-built copies of it would be three sets of drag maths, three
 * off-screen clamps and three ways of writing a setting back.
 *
 * So the shell lives here and the walks bring their own labels. What is
 * deliberately *not* here: any notion of a queue, a step, or a game action. The
 * widget draws and reports clicks; every rule about what a click does stays in
 * the feature, where the one-click-one-action discipline can be read in one
 * file.
 *
 * The setting rows write straight into the settings the feature already reads,
 * rather than into a copy — the gear and the settings page are then the same
 * switch, and there is no third place for them to disagree in.
 */

import config from '../core/config.js';
import storage from '../core/storage.js';

const LABEL_CSS = 'display:flex; align-items:center; gap:6px; font-size:11px; white-space:nowrap;';

/**
 * Stop a control from starting a drag or reaching the page behind it.
 * @param {HTMLElement} element - A control inside the widget
 */
function shieldFromDrag(element) {
    element.addEventListener('mousedown', (event) => event.stopPropagation());
    element.addEventListener('pointerdown', (event) => event.stopPropagation());
}

/**
 * Let the widget be dragged anywhere, and remember where it was left.
 *
 * Dragging starts only on the widget's own background, so the selects and the
 * buttons keep working: a drag beginning on a control would swallow the click
 * that was meant for it. The result is clamped into the viewport, because a
 * panel dragged off the edge cannot be dragged back.
 *
 * @param {HTMLElement} element - The widget
 * @param {Object} options - Where to persist the position
 * @param {string|null} options.positionKey - Settings key, or null for no memory
 * @param {{left: number, top: number}|null} options.position - Restored position
 * @param {Function} options.onMove - Called with the new position once a drag ends
 */
function makeWidgetDraggable(element, { positionKey, position, onMove }) {
    const applyPosition = (left, top) => {
        const maxLeft = Math.max(0, window.innerWidth - element.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - element.offsetHeight);
        element.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
        element.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
        element.style.right = 'auto';
    };

    if (position) {
        // Applied after layout so offsetWidth is real, or the clamp above would
        // measure a widget that has not been sized yet
        setTimeout(() => applyPosition(position.left, position.top), 0);
    }

    element.style.cursor = 'move';
    // Pointer events so a finger works too; mousedown never fires on a
    // touchscreen, and touch-action:none stops the browser claiming the gesture
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target.closest?.('button, select, input, label')) return;
        event.preventDefault();

        const rect = element.getBoundingClientRect();
        const grabX = event.clientX - rect.left;
        const grabY = event.clientY - rect.top;

        const onPointerMove = (move) => applyPosition(move.clientX - grabX, move.clientY - grabY);
        const onPointerUp = () => {
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerup', onPointerUp);
            document.removeEventListener('pointercancel', onPointerUp);
            const final = element.getBoundingClientRect();
            const left = final.left;
            const top = final.top;
            onMove?.({ left, top });
            if (positionKey) storage.set(positionKey, { left, top }, 'settings');
        };

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
    });
}

/**
 * Build a floating widget and hand back its parts.
 *
 * Nothing is wired to a behaviour: the caller sets the labels, listens to the
 * buttons, and fills the settings drawer with whichever rows it has.
 *
 * @param {Object} options - The widget's look and where it sits
 * @param {string} options.id - The element id, so a rebuild can find the old one
 * @param {string} [options.top] - Initial top offset
 * @param {string} [options.right] - Initial right offset
 * @param {string} [options.accent] - Main-button text colour
 * @param {string} [options.background] - Panel background
 * @param {string} [options.border] - Panel border colour
 * @param {string} [options.text] - Body text colour
 * @param {string} [options.dim] - Muted text colour
 * @param {number} [options.zIndex] - Stacking order; defaults to the floating-panel layer
 * @param {string|null} [options.positionKey] - Settings key remembering the drag position
 * @param {{left: number, top: number}|null} [options.position] - Position read back from that key
 * @param {string} [options.mainClass] - Extra class on the main button, for tests and styling
 * @param {string} [options.closeClass] - Extra class on the ✕
 * @param {string[]|null} [options.mainLabels] - Every label the main button will ever show. Given
 *   these, the button is sized to the widest of them once and stops resizing as the label changes,
 *   so nothing beside it moves. Opt in: without it the button behaves exactly as before.
 * @param {string|null} [options.statusWidth] - A fixed width for the status line instead of the
 *   default `max-width`, so the strip's own width stops following its text. Opt in.
 * @returns {Object} `{ element, row, status, extras, main, gear, close, settings, setSettingsOpen, setMainLabel, settingsOpen, remove }`
 */
export function createFloatingWidget({
    id,
    top = '70px',
    right = '24px',
    accent = '#9ec4ff',
    background = 'rgba(12,16,30,0.94)',
    border = 'rgba(74,158,255,0.45)',
    text = '#e0e0e0',
    dim = '#7d879c',
    zIndex,
    positionKey = null,
    position = null,
    mainClass = '',
    closeClass = '',
    mainLabels = null,
    statusWidth = null,
} = {}) {
    const element = document.createElement('div');
    element.id = id;
    element.style.cssText =
        `position:fixed; top:${top}; right:${right}; z-index:${zIndex || config.Z_FLOATING_PANEL || 9000}; ` +
        'display:flex; flex-direction:column; align-items:stretch; gap:6px; padding:5px 9px; border-radius:7px; ' +
        `background:${background}; border:1px solid ${border}; color:${text}; font-size:12px; font-family:inherit; ` +
        'box-shadow:0 3px 10px rgba(0,0,0,0.45); user-select:none;';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; gap:6px;';

    const status = document.createElement('span');
    status.className = `${id}-status`;
    // A fixed width, where one is asked for: the strip is anchored by one edge
    // and its width follows its content, so a status line that grows and
    // shrinks with the text drags everything beside it sideways.
    status.style.cssText = statusWidth
        ? `flex:0 0 ${statusWidth}; width:${statusWidth}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`
        : 'max-width:340px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

    // Whatever the feature wants between the status and the main button — a
    // category picker, a count, a second button
    const extras = document.createElement('span');
    extras.className = `${id}-extras`;
    extras.style.cssText = 'display:flex; align-items:center; gap:6px;';

    const main = document.createElement('button');
    main.className = `${id}-main${mainClass ? ` ${mainClass}` : ''}`;
    main.style.cssText =
        `border:0; border-radius:5px; background:rgba(74,158,255,0.25); color:${accent}; font-weight:700; ` +
        'font-size:12px; padding:3px 10px; cursor:pointer; font-family:inherit; white-space:nowrap;';
    shieldFromDrag(main);

    // Every label the button will ever carry, stacked in one grid cell with all
    // but the current one hidden. The button is then as wide as the widest of
    // them and stays that width as the label changes, so the controls beside it
    // hold their place — and the width is the browser's own measurement of the
    // real text in the real font, not a number guessed here that a different
    // font would silently break.
    const reservedLabels = Array.isArray(mainLabels) && mainLabels.length ? [...mainLabels] : null;
    /**
     * Add one stacked label span to the main button.
     * @param {string} label - The text it carries
     * @returns {HTMLElement} The span
     */
    function addMainLabel(label) {
        const span = document.createElement('span');
        span.className = `${id}-main-label`;
        span.dataset.label = label;
        span.textContent = label;
        span.style.cssText = 'grid-area:1 / 1; white-space:nowrap; visibility:hidden;';
        main.appendChild(span);
        return span;
    }
    if (reservedLabels) {
        main.style.display = 'grid';
        main.style.justifyItems = 'center';
        main.style.alignItems = 'center';
        for (const label of reservedLabels) addMainLabel(label);
    }

    const gear = document.createElement('button');
    gear.className = `${id}-gear`;
    gear.textContent = '⚙';
    gear.title = 'Show the settings this decides by';
    gear.style.cssText =
        `border:0; border-radius:5px; background:rgba(255,255,255,0.08); color:${text}; font-size:12px; ` +
        'line-height:1; padding:3px 6px; cursor:pointer; font-family:inherit;';
    shieldFromDrag(gear);

    const close = document.createElement('button');
    close.className = `${id}-close${closeClass ? ` ${closeClass}` : ''}`;
    close.textContent = '✕';
    close.style.cssText =
        `border:0; border-radius:5px; background:transparent; color:${dim}; font-size:12px; ` +
        'line-height:1; padding:3px 5px; cursor:pointer; font-family:inherit;';
    close.addEventListener('mouseenter', () => (close.style.color = text));
    close.addEventListener('mouseleave', () => (close.style.color = dim));
    shieldFromDrag(close);

    const settings = document.createElement('div');
    settings.className = `${id}-settings`;
    settings.style.cssText = 'display:none; flex-direction:column; gap:4px; padding-top:6px;';

    row.append(status, extras, main, gear, close);
    element.append(row, settings);

    makeWidgetDraggable(element, { positionKey, position, onMove: null });

    const widget = {
        element,
        row,
        status,
        extras,
        main,
        gear,
        close,
        settings,
        settingsOpen: false,
        /**
         * Fold the settings drawer out or away.
         * @param {boolean} open - Whether the drawer is shown
         */
        setSettingsOpen(open) {
            widget.settingsOpen = Boolean(open);
            settings.style.display = widget.settingsOpen ? 'flex' : 'none';
        },
        /**
         * Say what the main button reads now.
         *
         * Without `mainLabels` this is just the text, exactly as writing to
         * `main.textContent` was. With them the button keeps its reserved width
         * — and a label that was not declared is added to the reservation
         * rather than dropped, so a new state cannot make the button blank.
         *
         * @param {string} label - What the next press would do
         */
        setMainLabel(label) {
            if (!reservedLabels) {
                main.textContent = label;
                return;
            }
            if (!reservedLabels.includes(label)) {
                reservedLabels.push(label);
                addMainLabel(label);
            }
            for (const span of main.children) {
                span.style.visibility = span.dataset.label === label ? 'visible' : 'hidden';
            }
        },
        /** Take the widget off the page */
        remove() {
            element.remove();
        },
    };

    gear.addEventListener('click', () => widget.setSettingsOpen(!widget.settingsOpen));

    return widget;
}

/**
 * A line of explanation above a group of setting rows.
 * @param {string} message - What the rows below it do
 * @returns {HTMLElement}
 */
export function widgetNote(message) {
    const note = document.createElement('div');
    note.textContent = message;
    note.style.cssText = 'color:#7d879c; font-size:11px; max-width:340px; white-space:normal;';
    return note;
}

/** A hairline above the first setting row, so the drawer reads as its own thing */
export function widgetDivider() {
    const divider = document.createElement('div');
    divider.style.cssText = 'border-top:1px solid rgba(74,158,255,0.25); margin-bottom:2px;';
    return divider;
}

/**
 * A number field bound to a setting.
 *
 * Written on change rather than on every keystroke: half a typed number is a
 * rule too, and one that would be applied the moment it was typed.
 *
 * @param {Object} options - The setting and its wording
 * @param {string} options.key - Setting key
 * @param {number} options.fallback - Used when the setting is unset or nonsense
 * @param {string} options.label - What the field is called
 * @param {string} [options.suffix] - Units, shown after the field
 * @param {string} [options.title] - Hover explanation
 * @param {Function} [options.onChange] - Called with the new value once it is saved
 * @returns {HTMLElement}
 */
export function widgetNumberRow({ key, fallback, label, suffix = '', title = '', onChange }) {
    const line = document.createElement('label');
    line.style.cssText = `${LABEL_CSS} color:#cfd8ea;`;
    if (title) line.title = title;

    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'flex:1;';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.className = `mwi-widget-setting-${key}`;
    input.value = String(config.getSettingValue(key, fallback));
    input.style.cssText =
        'width:90px; border:1px solid rgba(74,158,255,0.35); border-radius:4px; background:rgba(20,26,44,0.95); ' +
        'color:#cfd8ea; font-size:11px; padding:2px 4px; font-family:inherit;';
    input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 0) {
            input.value = String(config.getSettingValue(key, fallback));
            return;
        }
        config.setSetting(key, value);
        onChange?.(value);
    });
    shieldFromDrag(input);

    const units = document.createElement('span');
    units.textContent = suffix;
    units.style.cssText = 'color:#7d879c; width:38px;';

    line.append(text, input, units);
    return line;
}

/**
 * A checkbox bound to a setting.
 * @param {Object} options - The setting and its wording
 * @param {string} options.key - Setting key
 * @param {string} options.label - What the box is called
 * @param {string} [options.title] - Hover explanation
 * @param {Function} [options.onChange] - Called with the new value once it is saved
 * @returns {HTMLElement}
 */
export function widgetCheckboxRow({ key, label, title = '', onChange }) {
    const line = document.createElement('label');
    line.style.cssText = `${LABEL_CSS} color:#cfd8ea; white-space:normal;`;
    if (title) line.title = title;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = `mwi-widget-setting-${key}`;
    box.checked = Boolean(config.getSetting(key));
    box.addEventListener('change', () => {
        config.setSetting(key, box.checked);
        onChange?.(box.checked);
    });
    shieldFromDrag(box);

    const text = document.createElement('span');
    text.textContent = label;

    line.append(box, text);
    return line;
}

/**
 * A dropdown bound to a setting.
 * @param {Object} options - The setting and its wording
 * @param {string} options.key - Setting key
 * @param {string} options.fallback - Used when the setting is unset
 * @param {string} options.label - What the dropdown is called
 * @param {Array<{value: string, label: string}>} options.options - What it offers
 * @param {string} [options.title] - Hover explanation
 * @param {Function} [options.onChange] - Called with the new value once it is saved
 * @returns {HTMLElement}
 */
export function widgetSelectRow({ key, fallback, label, options, title = '', onChange }) {
    const line = document.createElement('label');
    line.style.cssText = `${LABEL_CSS} color:#cfd8ea;`;
    if (title) line.title = title;

    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'flex:1;';

    const select = document.createElement('select');
    select.className = `mwi-widget-setting-${key}`;
    select.classList.add('toolasha-select');
    select.style.cssText =
        'border:1px solid rgba(74,158,255,0.35); border-radius:4px; background:rgba(20,26,44,0.95); ' +
        'color:#cfd8ea; font-size:11px; padding:2px 4px; cursor:pointer; font-family:inherit;';
    for (const option of options || []) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        select.appendChild(element);
    }
    select.value = String(config.getSettingValue(key, fallback));
    select.addEventListener('change', () => {
        config.setSetting(key, select.value);
        onChange?.(select.value);
    });
    shieldFromDrag(select);

    line.append(text, select);
    return line;
}

/**
 * A value the widget only reports — edited somewhere else, and said so.
 * @param {Object} options - The reading and where it comes from
 * @param {string} options.label - What it is
 * @param {string} options.value - What it says
 * @param {string} [options.hint] - Where it is edited
 * @param {string} [options.title] - Hover explanation
 * @returns {HTMLElement}
 */
export function widgetReadOnlyRow({ label, value, hint = '', title = '' }) {
    const line = document.createElement('div');
    line.style.cssText = `${LABEL_CSS} color:#cfd8ea; white-space:normal;`;
    if (title) line.title = title;

    const text = document.createElement('span');
    text.textContent = label;
    text.style.cssText = 'flex:1;';

    const reading = document.createElement('span');
    reading.textContent = value;
    reading.style.cssText = 'color:#cfd8ea; font-weight:700;';

    line.append(text, reading);
    if (hint) {
        const note = document.createElement('span');
        note.textContent = hint;
        note.style.cssText = 'color:#7d879c; width:100%; font-size:10px; white-space:normal;';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex; flex-direction:column; gap:1px;';
        wrap.append(line, note);
        return wrap;
    }
    return line;
}

export default {
    createFloatingWidget,
    widgetNote,
    widgetDivider,
    widgetNumberRow,
    widgetCheckboxRow,
    widgetSelectRow,
    widgetReadOnlyRow,
};
