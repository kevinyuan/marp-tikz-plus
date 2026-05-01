import * as crypto from 'crypto';

export function generateHash(source: string): string {
    const normalized = source.replace(/\r\n/g, '\n');
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function generateShortHash(source: string): string {
    return generateHash(source).substring(0, 16);
}
