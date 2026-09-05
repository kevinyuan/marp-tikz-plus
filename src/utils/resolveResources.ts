/**
 * Rewrites local image references in rendered Marp HTML to Obsidian resource URLs.
 *
 * The Marp preview injects its HTML straight into the Obsidian document, so a
 * relative reference like `diagrams/cover.svg` resolves against Obsidian's own
 * app URL rather than the vault, and the image silently fails to load. Every
 * local reference therefore has to be rewritten to a vault resource URL.
 *
 * Obsidian's `getResourcePath()` appends the file's modification time to the URL
 * it returns, so a regenerated image also gets a new URL and is re-fetched
 * instead of being painted from the cache.
 *
 * Two forms are rewritten:
 *   - `<img src="...">` for ordinary Markdown images
 *   - `url(...)` inside style attributes, which is what Marp emits for
 *     `![bg](...)` background directives
 */

/** Resolve one document-relative path to a URL, or null when it cannot be resolved. */
export type ResourceResolver = (relativePath: string) => string | null;

/** True for references that are already absolute and must be left alone. */
function isExternal(target: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(target)   // http:, https:, data:, app:, file:
        || target.startsWith('//')               // protocol-relative
        || target.startsWith('#');               // fragment only
}

function rewriteOne(raw: string, resolve: ResourceResolver): string {
    const target = raw.trim();
    if (!target || isExternal(target)) { return raw; }

    // Strip any query or fragment before resolving, then drop it: the resource
    // URL carries its own cache-busting query.
    const clean = target.split(/[?#]/)[0];
    if (!clean) { return raw; }

    let decoded = clean;
    try { decoded = decodeURI(clean); } catch { /* use as-is */ }

    const resolved = resolve(decoded);
    return resolved ?? raw;
}

const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;

/**
 * Rewrite every local image reference in `html` using `resolve`.
 * References that are external, or that `resolve` returns null for, are untouched.
 */
export function resolveLocalResources(html: string, resolve: ResourceResolver): string {
    let out = html.replace(IMG_SRC_RE, (_m, prefix: string, _quoted: string, dq?: string, sq?: string) => {
        if (dq !== undefined) { return `${prefix}"${rewriteOne(dq, resolve)}"`; }
        return `${prefix}'${rewriteOne(sq ?? '', resolve)}'`;
    });

    out = out.replace(CSS_URL_RE, (_m, dq?: string, sq?: string, bare?: string) => {
        const raw = dq ?? sq ?? bare ?? '';
        const rewritten = rewriteOne(raw, resolve);
        // Always emit a quoted URL: a resource path can contain characters that
        // are not valid in a bare CSS url() token.
        return `url("${rewritten.replace(/"/g, '\\"')}")`;
    });

    return out;
}

/**
 * Collect the local references `resolveLocalResources` would rewrite.
 * Used to watch those files for changes.
 */
export function collectLocalResources(html: string): string[] {
    const found: string[] = [];
    resolveLocalResources(html, (p) => { found.push(p); return null; });
    return found;
}
