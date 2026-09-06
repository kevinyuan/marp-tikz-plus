import { CacheEntry } from './CacheEntry';

export interface CacheStats {
    entryCount: number;
    totalSize: number;
}

interface SerializedEntry {
    hash: string;
    svg: string;
    timestamp: number;
    accessCount: number;
}

interface CacheData {
    index: string[];
    entries: Record<string, SerializedEntry>;
}

type SaveFn = (data: CacheData) => Promise<void>;
type LoadFn = () => Promise<CacheData | null>;

export class CacheManager {
    private static readonly MAX_PERSISTENT_ENTRIES = 128;

    private _data: CacheData = { index: [], entries: {} };
    private readonly _save: SaveFn;
    private _saveTimer: number | null = null;

    constructor(save: SaveFn, load: LoadFn) {
        this._save = save;
        // Load persisted data asynchronously on init
        load().then(data => {
            if (data) { this._data = data; }
        }).catch(() => { /* ignore */ });
    }

    async get(hash: string): Promise<CacheEntry | undefined> {
        const raw = this._data.entries[hash];
        if (!raw) { return undefined; }
        const entry = new CacheEntry(raw.hash, raw.svg, raw.timestamp, raw.accessCount);
        entry.touch();
        this._data.entries[hash] = {
            hash: entry.hash, svg: entry.svg,
            timestamp: entry.timestamp, accessCount: entry.accessCount,
        };
        this._scheduleSave();
        return entry;
    }

    async set(hash: string, diagram: CacheEntry): Promise<void> {
        this._data.entries[hash] = {
            hash: diagram.hash, svg: diagram.svg,
            timestamp: diagram.timestamp, accessCount: diagram.accessCount,
        };
        if (!this._data.index.includes(hash)) {
            this._data.index.push(hash);
        }
        this._evictIfNeeded();
        this._scheduleSave();
    }

    async invalidate(hash: string): Promise<void> {
        delete this._data.entries[hash];
        this._data.index = this._data.index.filter(h => h !== hash);
        this._scheduleSave();
    }

    async clear(): Promise<void> {
        this._data = { index: [], entries: {} };
        await this._save(this._data);
    }

    async getStats(): Promise<CacheStats> {
        const entryCount = this._data.index.length;
        let totalSize = 0;
        for (const hash of this._data.index) {
            const e = this._data.entries[hash];
            if (e) { totalSize += e.svg.length + 100; }
        }
        return { entryCount, totalSize };
    }

    private _evictIfNeeded(): void {
        const max = CacheManager.MAX_PERSISTENT_ENTRIES;
        if (this._data.index.length <= max) { return; }
        const toEvict = this._data.index.splice(0, this._data.index.length - max);
        for (const h of toEvict) { delete this._data.entries[h]; }
    }

    private _scheduleSave(): void {
        if (this._saveTimer) { window.clearTimeout(this._saveTimer); }
        this._saveTimer = window.setTimeout(() => {
            this._saveTimer = null;
            this._save(this._data).catch(() => { /* ignore */ });
        }, 1000);
    }
}
