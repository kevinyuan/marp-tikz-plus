import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { isMarpFile } from './slideParser';
import { generateHash } from '../utils/hash';
import type MarpTikzPlugin from '../../main';

export const MARP_VIEW_TYPE = 'marp-tikz-preview';

export class MarpView extends ItemView {
    private _file: TFile | null = null;
    private _pendingUpdate: ReturnType<typeof setTimeout> | null = null;

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

        // Substitute cached TikZ SVGs before Marp renders
        const tikzRe = /```tikz\s*\n([\s\S]*?)```/g;
        const processedContent = content.replace(tikzRe, (_match: string, source: string) => {
            const hash = generateHash(source.trim());
            const cached = this.plugin.renderer.getSvg(hash);
            if (cached?.svg) {
                // Wrap in a div so Marp (html:true) passes it through
                return `<div class="tikz-in-marp">${cached.svg}</div>`;
            }
            return `<div class="tikz-placeholder">⏳ Rendering TikZ…</div>`;
        });

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

        // Strip the polyfill <script> Marp injects (won't run inside Obsidian anyway)
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

        this.contentEl.empty();

        // Marp's CSS is fully scoped to `div.marpit > svg > foreignObject > section`
        // — safe to inject directly without iframe isolation
        const style = this.contentEl.createEl('style');
        style.textContent = css + `
            .marp-tikz-view {
                overflow-y: auto;
                padding: 16px;
                background: var(--background-secondary);
            }
            /* Each slide is an SVG with viewBox="0 0 1280 720" — scales naturally */
            .marp-tikz-view svg[data-marpit-svg] {
                width: 100%;
                height: auto;
                display: block;
                margin-bottom: 16px;
                box-shadow: 0 2px 14px rgba(0,0,0,.3);
                border-radius: 4px;
            }
            /* TikZ SVG inside slide */
            .marp-tikz-view .tikz-in-marp svg {
                max-width: 100%;
                height: auto;
            }
        `;

        const container = this.contentEl.createDiv();
        container.innerHTML = html;
    }

    async onClose(): Promise<void> {
        if (this._pendingUpdate) { clearTimeout(this._pendingUpdate); }
    }
}
