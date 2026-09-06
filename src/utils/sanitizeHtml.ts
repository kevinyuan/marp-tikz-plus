/**
 * Sanitizes generated HTML before it is inserted into the DOM.
 *
 * Obsidian's own `sanitizeHTMLToDom` (DOMPurify under the hood) strips
 * `<foreignObject>` by default — a reasonable default for arbitrary untrusted
 * HTML, but it also happens to be the element Marpit uses to embed each
 * slide's HTML content inside its SVG. Sanitizing with the default config
 * would silently blank out every slide.
 *
 * Instead we call Obsidian's bundled `window.DOMPurify` directly with
 * `foreignobject` re-added to the allow-list, so `<script>` tags, `on*` event
 * handler attributes and `javascript:` URLs are still stripped, while Marp's
 * and TikZ's SVG structure survives intact.
 */

import { sanitizeHTMLToDom } from 'obsidian';

interface DOMPurifyLike {
    sanitize(html: string, config: Record<string, unknown>): DocumentFragment;
}

declare global {
    interface Window {
        DOMPurify?: DOMPurifyLike;
    }
}

const SANITIZE_CONFIG = {
    ADD_TAGS: ['foreignobject'],
    RETURN_DOM_FRAGMENT: true,
} as const;

/**
 * Parses `html` into a sanitized DocumentFragment, ready to append to the DOM.
 * Falls back to Obsidian's `sanitizeHTMLToDom` (which will not preserve
 * `<foreignObject>`) if `window.DOMPurify` is unexpectedly unavailable.
 */
export function sanitizeToFragment(html: string): DocumentFragment {
    const purify = window.DOMPurify;
    if (purify) {
        return purify.sanitize(html, SANITIZE_CONFIG);
    }
    console.warn('[MarpTikz] window.DOMPurify unavailable; falling back to sanitizeHTMLToDom (SVG foreignObject content will be stripped)');
    return sanitizeHTMLToDom(html);
}

/** Replaces all children of `el` with the sanitized contents of `html`. */
export function setSanitizedHtml(el: HTMLElement, html: string): void {
    el.replaceChildren(sanitizeToFragment(html));
}
