import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves %!include / %!notes directives in Marp frontmatter and speaker notes.
 *
 * Frontmatter syntax (any line inside the YAML block):
 *   %!include _theme.yaml
 *
 * Speaker notes syntax (standalone line, NOT inside a comment):
 *   %!notes notes/slide1.md
 *
 * The preprocessor converts %!notes to a proper <!-- content --> comment before
 * Marp parses the source, so speaker notes from external files are rendered
 * correctly in the slide preview and notes panel.
 *
 * File content is cached by absolute path with mtime+size validation.
 */

interface FileCacheEntry {
    content: string;
    mtimeMs: number;
    size: number;
}

const FRONTMATTER_INCLUDE_LINE_RE = /^%!include\s+(.+)$/m;
const NOTES_DIRECTIVE_RE = /^[ \t]*%!notes[ \t]+(.+?)[ \t]*$/gm;

export class MarkdownIncludeResolver {
    private readonly _cache = new Map<string, FileCacheEntry>();
    private _trackedPaths = new Set<string>();

    getTrackedPaths(): Set<string> {
        return this._trackedPaths;
    }

    clearTracked(): void {
        this._trackedPaths = new Set<string>();
    }

    invalidate(filePath: string): void {
        this._cache.delete(filePath);
    }

    resolve(src: string, baseDir: string): string {
        let out = this._resolveFrontmatter(src, baseDir);
        out = this._resolveNotes(out, baseDir);
        return out;
    }

    private _readFile(filePath: string): string | null {
        try {
            const stat = fs.statSync(filePath);
            const cached = this._cache.get(filePath);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                return cached.content;
            }
            const content = fs.readFileSync(filePath, 'utf8');
            this._cache.set(filePath, { content, mtimeMs: stat.mtimeMs, size: stat.size });
            return content;
        } catch {
            return null;
        }
    }

    private _resolveFilePath(rawPath: string, baseDir: string): string {
        return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
    }

    _resolveFrontmatter(src: string, baseDir: string): string {
        if (!FRONTMATTER_INCLUDE_LINE_RE.test(src)) { return src; }

        const fmMatch = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*/);
        if (!fmMatch) { return src; }

        const fmBody = fmMatch[1];
        if (!FRONTMATTER_INCLUDE_LINE_RE.test(fmBody)) { return src; }

        const resolvedBody = fmBody.replace(/^%!include\s+(.+)$/mg, (_, rawFile: string) => {
            const filePath = this._resolveFilePath(rawFile.trim(), baseDir);
            this._trackedPaths.add(filePath);
            const content = this._readFile(filePath);
            if (content === null) {
                return `# markdownPreprocessor: cannot include ${rawFile.trim()}`;
            }
            return content.trim();
        });

        const fmEnd = fmMatch.index! + fmMatch[0].length;
        return '---\n' + resolvedBody + '\n---' + src.slice(fmEnd);
    }

    _resolveNotes(src: string, baseDir: string): string {
        if (!src.includes('%!notes')) { return src; }

        NOTES_DIRECTIVE_RE.lastIndex = 0;
        return src.replace(NOTES_DIRECTIVE_RE, (_, rawFile: string) => {
            const filePath = this._resolveFilePath(rawFile.trim(), baseDir);
            this._trackedPaths.add(filePath);
            const content = this._readFile(filePath);
            if (content === null) {
                return `<!-- markdownPreprocessor: cannot include ${rawFile.trim()} -->`;
            }
            return `<!--\n${content.trim()}\n-->`;
        });
    }
}
