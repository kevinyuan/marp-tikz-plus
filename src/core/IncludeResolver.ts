import * as path from 'path';
import * as fs from 'fs';

const INCLUDE_REGEX = /^%!include\s+(.+)$/m;

export interface ResolvedInclude {
    filePath: string;
    content: string;
}

export interface IncludeError {
    filePath: string;
    message: string;
}

export type IncludeResult =
    | { ok: true; value: ResolvedInclude }
    | { ok: false; error: IncludeError };

interface CacheEntry {
    content: string;
    mtimeMs: number;
    size: number;
}

export class IncludeResolver {
    private readonly _fileCache = new Map<string, CacheEntry>();

    resolve(source: string, baseDir: string): IncludeResult | undefined {
        const firstNonEmpty = source.trim().split('\n')[0]?.trim();
        if (!firstNonEmpty) { return undefined; }

        const match = INCLUDE_REGEX.exec(firstNonEmpty);
        if (!match) { return undefined; }

        const raw = match[1].trim();
        const filePath = path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);

        try {
            const stat = fs.statSync(filePath);
            const cached = this._fileCache.get(filePath);
            if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
                return { ok: true, value: { filePath, content: cached.content } };
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            this._fileCache.set(filePath, { content, mtimeMs: stat.mtimeMs, size: stat.size });
            return { ok: true, value: { filePath, content } };
        } catch (err: any) {
            this._fileCache.delete(filePath);
            const message = err?.code === 'ENOENT'
                ? `File not found: ${filePath}`
                : `Failed to read file: ${filePath} — ${err?.message ?? err}`;
            return { ok: false, error: { filePath, message } };
        }
    }

    invalidate(filePath: string): void {
        this._fileCache.delete(filePath);
    }

    clearCache(): void {
        this._fileCache.clear();
    }

    get cachedPaths(): string[] {
        return [...this._fileCache.keys()];
    }
}
