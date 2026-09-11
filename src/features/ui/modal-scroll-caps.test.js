/**
 * @vitest-environment happy-dom
 *
 * The Firefox modal scroll caps, checked for what a stylesheet can get wrong.
 *
 * happy-dom does no layout, so the caps' actual effect — whether a scroller
 * really stops short of a frame in Firefox — cannot be asserted here; that was
 * measured by hand against the game's real stylesheet (see modal-scroll-caps.js).
 * What is testable, and what would actually break, is scope: the generic
 * `Modal_modalContent` wrapper is shared with the marketplace and every
 * settings dialog, so a rule that forgets its `:has()` caps all of them.
 */

import { describe, test, expect, afterEach } from 'vitest';

import modalScrollCaps from './modal-scroll-caps.js';

const styleEl = () => document.getElementById('toolasha-modal-scroll-caps');

afterEach(() => {
    modalScrollCaps.disable();
});

describe('modal scroll caps', () => {
    test('initialize adds the stylesheet, idempotently', () => {
        expect(styleEl()).toBeNull();

        modalScrollCaps.initialize();
        expect(styleEl()).not.toBeNull();

        // A second initialize() must not append a second <style> tag
        modalScrollCaps.initialize();
        expect(document.querySelectorAll('#toolasha-modal-scroll-caps')).toHaveLength(1);
    });

    test('disable removes it', () => {
        modalScrollCaps.initialize();
        modalScrollCaps.disable();
        expect(styleEl()).toBeNull();
    });

    test('cleanup is as thorough as disable', () => {
        modalScrollCaps.initialize();
        modalScrollCaps.cleanup();
        expect(styleEl()).toBeNull();
    });

    test('re-initializing after cleanup restores it', () => {
        modalScrollCaps.initialize();
        modalScrollCaps.cleanup();
        expect(styleEl()).toBeNull();

        modalScrollCaps.initialize();
        expect(styleEl()).not.toBeNull();
    });

    test('the dialog-specific rules need no :has() — their class names are unique to one dialog', () => {
        modalScrollCaps.initialize();
        const css = styleEl().textContent;

        expect(css).toContain('OfflineProgressModal_modalContent');
        expect(css).toContain('SharableProfile_modalContent');
    });

    test('the generic Modal_modalContent rule is scoped to the Item Dictionary only', () => {
        // Modal_modalContent is the marketplace's and every settings dialog's
        // own wrapper class too — an ungated rule here would cap all of them.
        modalScrollCaps.initialize();

        const rules = styleEl()
            .textContent.split('}')
            .map((block) => block.split('{')[0].trim())
            .filter(Boolean);

        for (const selector of rules.filter((rule) => rule.includes('Modal_modalContent'))) {
            // Either it's one of the two dialog-specific compound classes, or
            // it's the generic wrapper and must be :has()-gated on the Item
            // Dictionary's own content class.
            const isDialogSpecific =
                selector.includes('OfflineProgressModal_modalContent') ||
                selector.includes('SharableProfile_modalContent');
            if (!isDialogSpecific) {
                expect(selector).toContain('ItemDictionary_modalContent');
            }
        }
        expect(rules.some((rule) => rule.includes('ItemDictionary_modalContent'))).toBe(true);
    });

    test('every rule only ever lowers a ceiling — max-height, never height', () => {
        modalScrollCaps.initialize();
        const css = styleEl().textContent;

        expect(css).toContain('max-height');
        expect(css).not.toMatch(/[^-]height:\s*(?!auto)/);
    });
});
