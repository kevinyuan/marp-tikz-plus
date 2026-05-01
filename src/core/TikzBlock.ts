import { generateHash } from '../utils/hash';

export class TikzBlock {
    readonly id: string;
    readonly source: string;
    readonly hash: string;
    readonly lineNumber: number;

    constructor(source: string, lineNumber: number) {
        this.id = `tikz-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        this.source = source;
        this.hash = generateHash(source.trim());
        this.lineNumber = lineNumber;
    }

    equals(other: TikzBlock): boolean {
        return this.hash === other.hash;
    }
}
