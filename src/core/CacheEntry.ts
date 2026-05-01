export class CacheEntry {
    hash: string;
    svg: string;
    timestamp: number;
    accessCount: number;

    constructor(hash: string, svg: string, timestamp = Date.now(), accessCount = 0) {
        this.hash = hash;
        this.svg = svg;
        this.timestamp = timestamp;
        this.accessCount = accessCount;
    }

    isExpired(maxAge: number): boolean {
        return Date.now() - this.timestamp > maxAge;
    }

    touch(): void {
        this.accessCount++;
    }
}
