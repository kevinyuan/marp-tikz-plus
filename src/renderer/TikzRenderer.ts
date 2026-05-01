import { CacheManager } from '../core/CacheManager';
import { CacheEntry } from '../core/CacheEntry';
import { preprocessSource } from '../utils/preprocessor';
import { postProcessSvg } from '../utils/svgPostProcessor';

export class TikzRenderer {
    private readonly _svgCache = new Map<string, { svg?: string; error?: string }>();
    private static readonly MAX_MEMORY_CACHE = 64;

    private _tikzjaxLoaded = false;
    private _tikzjaxLoadPromise: Promise<void> | null = null;
    private _renderChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly cacheManager: CacheManager,
        private readonly getTimeout: () => number,
        private readonly isDarkMode: () => boolean,
        private readonly log: (msg: string) => void,
    ) {}

    getSvg(hash: string): { svg?: string; error?: string } | undefined {
        return this._svgCache.get(hash);
    }

    clearMemoryCache(): void {
        this._svgCache.clear();
    }

    async renderBlocks(
        blocks: Array<{ hash: string; source: string }>,
        onBlockDone?: () => void,
    ): Promise<void> {
        for (const block of blocks) {
            if (this._svgCache.has(block.hash)) { continue; }

            const cached = await this.cacheManager.get(block.hash);
            if (cached) {
                const processed = postProcessSvg(cached.svg, this.isDarkMode());
                this._setSvgCache(block.hash, { svg: processed });
                onBlockDone?.();
                continue;
            }

            await this._renderSingleBlock(block.hash, block.source);
            onBlockDone?.();
        }
    }

    /** Public render for PPTX export — serialized, returns raw SVG. */
    async renderTikzToSvg(source: string): Promise<string> {
        let result!: string;
        const p = this._renderChain.then(async () => {
            result = await this._doRender(source);
        });
        this._renderChain = p.then(() => {}, () => {});
        await p;
        return result;
    }

    private async _renderSingleBlock(hash: string, source: string): Promise<void> {
        const p = this._renderChain.then(async () => {
            // Guard: another renderBlocks call may have already rendered this hash
            // while this item was queued in the chain.
            if (this._svgCache.has(hash)) { return; }
            this.log(`block ${hash.slice(0, 8)} — rendering...`);
            try {
                const svg = await this._doRender(source);
                const processed = postProcessSvg(svg, this.isDarkMode());
                this._setSvgCache(hash, { svg: processed });
                await this.cacheManager.set(hash, new CacheEntry(hash, svg));
                this.log(`block ${hash.slice(0, 8)} — OK`);
            } catch (err: unknown) {
                const msg = this._extractTexError(err);
                this._setSvgCache(hash, { error: msg });
                this.log(`block ${hash.slice(0, 8)} — FAILED: ${msg.slice(0, 120)}`);
            }
        });
        this._renderChain = p.then(() => {}, () => {});
        await p;
    }

    private async _doRender(source: string): Promise<string> {
        await this._ensureLoaded();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const tex2svg = require('node-tikzjax').default as (src: string, opts: Record<string, unknown>) => Promise<string>;

        let processed = preprocessSource(source);
        processed = processed.replace(
            /\\pgfplotsset\s*\{\s*compat\s*=\s*[\d.]+\s*\}/,
            '\\pgfplotsset{compat=1.16}'
        );

        const timeout = this.getTimeout();
        // disableSanitize skips jsdom in dvi2svg — jsdom uses the deprecated vm
        // module and is very slow in Electron's renderer process. We extract the
        // SVG element ourselves using a lightweight regex instead.
        const svgPromise = tex2svg(processed, {
            showConsole: false,
            texPackages: this._detectPackages(processed),
            tikzLibraries: this._detectTikzLibraries(processed).join(','),
            disableSanitize: true,
        }).then(_extractSvg);

        let timer!: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Render timed out after ${timeout}ms`)), timeout);
        });

        try {
            return await Promise.race([svgPromise, timeoutPromise]);
        } finally {
            clearTimeout(timer);
        }
    }

    private _detectPackages(source: string): Record<string, string> {
        const packages: Record<string, string> = {};
        const re = /\\usepackage(?:\[([^\]]*)\])?\{([^}]+)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            packages[m[2].trim()] = m[1] || '';
        }
        return packages;
    }

    private _detectTikzLibraries(source: string): string[] {
        const libs: string[] = [];
        const re = /\\usetikzlibrary\{([^}]+)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            libs.push(...m[1].split(',').map(s => s.trim()).filter(Boolean));
        }
        return libs;
    }

    private _extractTexError(err: unknown): string {
        const msg = (err as any)?.message || String(err);
        const texMatch = msg.match(/!(.*?)(?:\n|$)/);
        if (texMatch) { return `TeX compilation failed: ${texMatch[1].trim()}`; }
        if (msg.includes('timed out')) { return msg; }
        return `TeX compilation failed. Check your LaTeX syntax.\n${msg.slice(0, 300)}`;
    }

    private _setSvgCache(hash: string, value: { svg?: string; error?: string }): void {
        this._svgCache.delete(hash);
        this._svgCache.set(hash, value);
        while (this._svgCache.size > TikzRenderer.MAX_MEMORY_CACHE) {
            const oldest = this._svgCache.keys().next().value;
            if (oldest !== undefined) { this._svgCache.delete(oldest); }
        }
    }

    private async _ensureLoaded(): Promise<void> {
        if (this._tikzjaxLoaded) { return; }
        if (this._tikzjaxLoadPromise) { return this._tikzjaxLoadPromise; }
        this._tikzjaxLoadPromise = (async () => {
            this.log('Loading node-tikzjax...');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            require('node-tikzjax');
            this._tikzjaxLoaded = true;
            this.log('node-tikzjax loaded');
        })();
        return this._tikzjaxLoadPromise;
    }

    async reset(): Promise<void> {
        this._tikzjaxLoaded = false;
        this._tikzjaxLoadPromise = null;
        this._svgCache.clear();
    }
}

/** Extract the <svg>...</svg> element from raw dvi2html output. */
function _extractSvg(raw: string): string {
    const m = raw.match(/<svg[\s\S]*<\/svg>/i);
    return m ? m[0] : raw;
}
