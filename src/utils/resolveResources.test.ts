import { resolveLocalResources, collectLocalResources } from './resolveResources';

/** Fake Obsidian resolver: known files get an app:// URL with an mtime query. */
const known: Record<string, number> = {
    'diagrams/cover.svg': 111,
    'img/photo.png': 222,
    'sp ace.png': 333,
};
const resolve = (p: string): string | null =>
    known[p] !== undefined ? `app://vault/${p}?${known[p]}` : null;

describe('resolveLocalResources', () => {
    it('rewrites img src to a resource URL', () => {
        expect(resolveLocalResources('<img src="diagrams/cover.svg">', resolve))
            .toBe('<img src="app://vault/diagrams/cover.svg?111">');
    });

    it('keeps other img attributes intact', () => {
        expect(resolveLocalResources('<img class="c" src="img/photo.png" width="50">', resolve))
            .toBe('<img class="c" src="app://vault/img/photo.png?222" width="50">');
    });

    it('handles single quotes and percent-encoded spaces', () => {
        expect(resolveLocalResources("<img src='img/photo.png'>", resolve))
            .toBe("<img src='app://vault/img/photo.png?222'>");
        expect(resolveLocalResources('<img src="sp%20ace.png">', resolve))
            .toBe('<img src="app://vault/sp ace.png?333">');
    });

    it('rewrites CSS url() from Marp background directives', () => {
        expect(resolveLocalResources('<div style="background-image:url(\'diagrams/cover.svg\')">', resolve))
            .toBe('<div style="background-image:url(&quot;app://vault/diagrams/cover.svg?111&quot;)">'
                .replace(/&quot;/g, '"'));
    });

    it('rewrites bare and double-quoted url() forms', () => {
        expect(resolveLocalResources('url(diagrams/cover.svg)', resolve))
            .toBe('url("app://vault/diagrams/cover.svg?111")');
        expect(resolveLocalResources('url("img/photo.png")', resolve))
            .toBe('url("app://vault/img/photo.png?222")');
    });

    it('drops an existing query before resolving', () => {
        expect(resolveLocalResources('<img src="img/photo.png?v=1">', resolve))
            .toBe('<img src="app://vault/img/photo.png?222">');
    });

    it('leaves external and unresolvable references alone', () => {
        const cases = [
            '<img src="https://example.com/a.png">',
            '<img src="data:image/png;base64,AAA">',
            '<img src="app://vault/already.png?1">',
            '<img src="//cdn/a.png">',
            '<img src="missing.png">',
        ];
        for (const c of cases) {
            expect(resolveLocalResources(c, resolve)).toBe(c);
        }
    });

    it('leaves an unresolvable url() in place, only normalising the quoting', () => {
        expect(resolveLocalResources('url(missing.png)', resolve)).toBe('url("missing.png")');
    });

    it('rewrites several references in one document', () => {
        const html = '<img src="diagrams/cover.svg"><section style="background-image:url(img/photo.png)">';
        expect(resolveLocalResources(html, resolve))
            .toBe('<img src="app://vault/diagrams/cover.svg?111">'
                + '<section style="background-image:url("app://vault/img/photo.png?222")">');
    });
});

describe('collectLocalResources', () => {
    it('lists the local references that would be rewritten', () => {
        const html = '<img src="diagrams/cover.svg"><div style="background:url(img/photo.png)">'
            + '<img src="https://x/y.png">';
        expect(collectLocalResources(html)).toEqual(['diagrams/cover.svg', 'img/photo.png']);
    });
});
