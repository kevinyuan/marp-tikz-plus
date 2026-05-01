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

        let { Marp } = require('@marp-team/marp-core');
        const marp = new Marp({ html: true });

        // Replace tikz code blocks with cached SVGs before Marp renders
        const tikzRe = /```tikz\s*\n([\s\S]*?)```/g;
        const processedContent = content.replace(tikzRe, (_match: string, source: string) => {
            const hash = generateHash(source.trim());
            const cached = this.plugin.renderer.getSvg(hash);
            if (cached?.svg) {
                return `<div class="tikz-in-marp">${cached.svg}</div>`;
            }
            return '<div class="tikz-in-marp tikz-placeholder">⏳ Rendering TikZ…</div>';
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

        // Split into slides (Marp wraps each in <section>)
        const slideRe = /<section[^>]*>([\s\S]*?)<\/section>/g;
        const slideHtmls: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = slideRe.exec(html)) !== null) {
            slideHtmls.push(m[0]);
        }

        this.contentEl.empty();
        const style = this.contentEl.createEl('style');
        style.textContent = css + `
            .marp-tikz-view { overflow-y: auto; background: var(--background-secondary); padding: 16px; }
            .marp-slide-wrapper { margin: 0 auto 24px; max-width: 720px; }
            .marp-slide-wrapper section { width: 100%; aspect-ratio: 16/9; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.25); border-radius: 4px; }
        `;

        const container = this.contentEl.createDiv({ cls: 'marp-slides-container' });
        slideHtmls.forEach((slideHtml, i) => {
            const wrapper = container.createDiv({ cls: 'marp-slide-wrapper' });
            wrapper.setAttribute('data-slide', String(i + 1));
            wrapper.innerHTML = slideHtml;
        });
    }

    async onClose(): Promise<void> {
        if (this._pendingUpdate) { clearTimeout(this._pendingUpdate); }
    }
}
