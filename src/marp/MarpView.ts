import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { isMarpFile, parseSpeakerNotes } from './slideParser';
import { generateHash } from '../utils/hash';
import type MarpTikzPlugin from '../../main';

export const MARP_VIEW_TYPE = 'marp-tikz-preview';

export class MarpView extends ItemView {
    private _file: TFile | null = null;
    private _pendingUpdate: ReturnType<typeof setTimeout> | null = null;
    private _resizeObserver: ResizeObserver | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: MarpTikzPlugin) {
        super(leaf);
    }

    getViewType(): string { return MARP_VIEW_TYPE; }
    getDisplayText(): string { return this._file ? `Marp: ${this._file.basename}` : 'Marp Preview'; }
    getIcon(): string { return 'presentation'; }

    async onOpen(): Promise<void> {
        this.contentEl.addClass('marp-tikz-view');
        this.contentEl.createEl('p', {
            text: 'Open a Marp markdown file and use "Open Marp Preview" to view slides here.',
            cls: 'marp-tikz-placeholder'
        });
    }

    setFile(file: TFile): void {
        this._file = file;
        this._scheduleUpdate();
    }

    scheduleUpdate(): void {
        this._scheduleUpdate();
    }

    private _scheduleUpdate(): void {
        if (this._pendingUpdate) { clearTimeout(this._pendingUpdate); }
        this._pendingUpdate = setTimeout(() => {
            this._pendingUpdate = null;
            this._render().catch(e => console.error('[MarpView]', e));
        }, 300);
    }

    private async _render(): Promise<void> {
        if (!this._file) { return; }
        const content = await this.app.vault.read(this._file);
        if (!isMarpFile(content)) {
            this.contentEl.empty();
            this.contentEl.createEl('p', {
                text: 'Not a Marp file (add marp: true to frontmatter).',
                cls: 'marp-tikz-placeholder'
            });
            return;
        }

        const { Marp } = require('@marp-team/marp-core');
        const marp = new Marp({ html: true });

        // Substitute cached TikZ SVGs; collect uncached blocks for background render
        const tikzRe = /```tikz\s*\n([\s\S]*?)```/g;
        const uncached: Array<{ hash: string; source: string }> = [];
        const processedContent = content.replace(tikzRe, (_match: string, raw: string) => {
            const source = raw.trim();
            const hash = generateHash(source);
            const cached = this.plugin.renderer.getSvg(hash);
            if (cached?.svg) {
                return `<div class="tikz-in-marp">${cached.svg}</div>`;
            }
            uncached.push({ hash, source });
            return `<div class="tikz-placeholder">⏳ Rendering TikZ…</div>`;
        });

        if (uncached.length > 0) {
            this.plugin.renderer
                .renderBlocks(uncached, () => this._scheduleUpdate())
                .catch(e => console.error('[MarpView] TikZ render error', e));
        }

        let html: string;
        let css: string;
        try {
            const result = marp.render(processedContent);
            html = result.html;
            css = result.css;
        } catch (e) {
            new Notice('Marp render error: ' + (e as Error).message);
            return;
        }

        html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

        // Split individual <svg data-marpit-svg> blocks (one per slide)
        const slideRe = /(<svg[^>]*data-marpit-svg[^>]*>[\s\S]*?<\/svg>)/g;
        const slideSvgs: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = slideRe.exec(html)) !== null) {
            slideSvgs.push(m[1]);
        }

        // Extract speaker notes (one entry per slide)
        const notes = parseSpeakerNotes(content);

        // Extract slide headings for navigator
        const headings = slideSvgs.map((svgHtml) => {
            const hMatch = svgHtml.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/i);
            return hMatch ? hMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        });

        // Teardown
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        this.contentEl.empty();

        // ── Styles ─────────────────────────────────────────────────────────────
        const style = this.contentEl.createEl('style');
        style.textContent = css + `
            .marp-tikz-view {
                display: flex;
                flex-direction: column;
                height: 100%;
                overflow: hidden;
                background: var(--background-secondary);
            }
            .marp-view-body {
                display: flex;
                flex: 1;
                overflow: hidden;
            }
            /* Navigator sidebar */
            .marp-nav {
                width: 160px;
                flex-shrink: 0;
                overflow-y: auto;
                border-right: 1px solid var(--background-modifier-border);
                padding: 8px 4px;
                background: var(--background-primary);
            }
            .marp-nav-item {
                display: flex;
                align-items: flex-start;
                gap: 6px;
                padding: 5px 6px;
                border-radius: 4px;
                cursor: pointer;
                margin-bottom: 4px;
                font-size: 0.8em;
                color: var(--text-muted);
            }
            .marp-nav-item:hover { background: var(--background-modifier-hover); }
            .marp-nav-item.active { background: var(--interactive-accent); color: var(--text-on-accent); }
            .marp-nav-num {
                font-weight: 700;
                font-size: 0.85em;
                min-width: 18px;
                padding-top: 1px;
            }
            .marp-nav-title {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 1;
            }
            /* Main scroll area */
            .marp-scroll-area {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
            }
            /* Slide + notes block */
            .marp-slide-block { margin-bottom: 24px; }
            .marp-slide-block svg[data-marpit-svg] {
                width: 100%;
                height: auto;
                display: block;
                box-shadow: 0 2px 14px rgba(0,0,0,.3);
                border-radius: 4px;
            }
            /* Speaker notes */
            .marp-slide-notes {
                margin-top: 6px;
                padding: 8px 12px;
                background: var(--background-primary);
                border-left: 3px solid var(--interactive-accent);
                border-radius: 0 4px 4px 0;
                font-size: 0.85em;
                color: var(--text-muted);
                white-space: pre-wrap;
            }
            /* TikZ inside slide */
            .marp-tikz-view .tikz-in-marp svg { max-width: 100%; height: auto; }
        `;

        // ── Layout skeleton ────────────────────────────────────────────────────
        const body = this.contentEl.createDiv({ cls: 'marp-view-body' });
        const nav = body.createDiv({ cls: 'marp-nav' });
        const scrollArea = body.createDiv({ cls: 'marp-scroll-area' });

        // ── Slides + notes ─────────────────────────────────────────────────────
        const slideBlocks: HTMLElement[] = [];
        slideSvgs.forEach((svgHtml, i) => {
            const block = scrollArea.createDiv({ cls: 'marp-slide-block' });
            block.dataset.slide = String(i);
            block.innerHTML = svgHtml;
            slideBlocks.push(block);

            const note = notes[i];
            if (note && note.trim()) {
                block.createDiv({ cls: 'marp-slide-notes', text: note.trim() });
            }
        });

        // ── Navigator items ────────────────────────────────────────────────────
        const navItems: HTMLElement[] = [];
        slideSvgs.forEach((_svg, i) => {
            const item = nav.createDiv({ cls: 'marp-nav-item' });
            item.createSpan({ cls: 'marp-nav-num', text: String(i + 1) });
            item.createSpan({ cls: 'marp-nav-title', text: headings[i] || `Slide ${i + 1}` });
            if (i === 0) { item.addClass('active'); }
            item.addEventListener('click', () => {
                slideBlocks[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            navItems.push(item);
        });

        // Sync active nav item while scrolling
        const io = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const idx = Number((entry.target as HTMLElement).dataset.slide);
                    navItems.forEach((item, i) => item.classList.toggle('active', i === idx));
                }
            });
        }, { root: scrollArea, threshold: 0.5 });
        slideBlocks.forEach(b => io.observe(b));

        // ── ResizeObserver not needed — SVGs scale via width:100% automatically ──
    }

    async onClose(): Promise<void> {
        if (this._pendingUpdate) { clearTimeout(this._pendingUpdate); }
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
    }
}
