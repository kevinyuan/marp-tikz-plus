/**
 * Applies Marp's per-file theme CSS via a constructed stylesheet instead of a
 * `<style>` element. Obsidian's plugin guidelines disallow creating/attaching
 * `<style>` tags at runtime (styles.css is meant to cover static rules), but
 * Marp's theme CSS is generated per-file by `marp.render()` and has to be
 * applied dynamically. `CSSStyleSheet` + `document.adoptedStyleSheets` covers
 * that without touching the DOM.
 */
export class MarpStyleSheet {
    private readonly _sheet = new CSSStyleSheet();
    private _attached = false;

    /** Replaces the sheet's rules with `css` and ensures it's adopted by the document. */
    update(css: string): void {
        this._sheet.replaceSync(css);
        if (!this._attached) {
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, this._sheet];
            this._attached = true;
        }
    }

    /** Detaches the sheet from the document. Call from the owning view's onClose(). */
    detach(): void {
        if (!this._attached) { return; }
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== this._sheet);
        this._attached = false;
    }
}
