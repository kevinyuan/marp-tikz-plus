import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { parseSlides, SlideInfo } from './slideParser';
import { generateHash } from '../utils/hash';
import type MarpTikzPlugin from '../../main';

export const SLIDE_NAVIGATOR_VIEW_TYPE = 'marp-tikz-slide-navigator';

export class SlideNavigatorView extends ItemView {
    private _file: TFile | null = null;
    private _pendingUpdate: ReturnType<typeof setTimeout> | null = null;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: MarpTikzPlugin) {
        super(leaf);
    }

    getViewType(): string { return SLIDE_NAVIGATOR_VIEW_TYPE; }
    getDisplayText(): string { return 'Slide Navigator'; }
    getIcon(): string { return 'layout-list'; }

    async onOpen(): Promise<void> {
        this.contentEl.addClass('marp-tikz-navigator');
        this._renderPlaceholder();
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
            this._render().catch(e => console.error('[SlideNavigator]', e));
        }, 400);
    }

    private _renderPlaceholder(): void {
        this.contentEl.empty();
        this.contentEl.createEl('p', {
            text: 'Open a Marp file to see slides.',
            cls: 'marp-tikz-placeholder'
        });
    }

    private async _render(): Promise<void> {
        if (!this._file) { this._renderPlaceholder(); return; }
        const content = await this.app.vault.read(this._file);
        const slides = parseSlides(content);

        if (slides.length === 0) { this._renderPlaceholder(); return; }

        // Generate thumbnail HTML for each slide using marp-core
        let slideHtmls: string[] = [];
        let css = '';
        try {
            const { Marp } = require('@marp-team/marp-core');
            const marp = new Marp({ html: true });
            const tikzRe = /```tikz\s*\n([\s\S]*?)```/g;
            const processed = content.replace(tikzRe, (_match: string, source: string) => {
                const hash = generateHash(source.trim());
                const cached = this.plugin.renderer.getSvg(hash);
                if (cached?.svg) { return `<div class="tikz-thumb">${cached.svg}</div>`; }
                return '<div class="tikz-thumb"></div>';
            });
            const result = marp.render(processed);
            css = result.css;
            const slideRe = /<section[^>]*>[\s\S]*?<\/section>/g;
            let m: RegExpExecArray | null;
            while ((m = slideRe.exec(result.html)) !== null) { slideHtmls.push(m[0]); }
        } catch { /* fallback to text list */ }

        this.contentEl.empty();
        if (css) {
            const style = this.contentEl.createEl('style');
            style.textContent = css + `
                .marp-tikz-navigator { overflow-y: auto; padding: 8px; }
                .nav-slide { cursor: pointer; margin-bottom: 8px; border-radius: 4px; border: 1px solid var(--background-modifier-border); overflow: hidden; }
                .nav-slide:hover { border-color: var(--interactive-accent); }
                .nav-slide-thumb { width: 100%; aspect-ratio: 16/9; overflow: hidden; position: relative; }
                .nav-slide-thumb section { width: 100%; height: 100%; transform-origin: top left; }
                .nav-slide-label { padding: 4px 6px; font-size: 11px; color: var(--text-muted); display: flex; gap: 6px; }
                .nav-slide-num { font-weight: 600; color: var(--text-normal); }
            `;
        }

        slides.forEach((slide: SlideInfo, idx: number) => {
            const el = this.contentEl.createDiv({ cls: 'nav-slide' });
            el.setAttribute('data-line', String(slide.line));

            const thumb = el.createDiv({ cls: 'nav-slide-thumb' });
            if (slideHtmls[idx]) {
                thumb.innerHTML = slideHtmls[idx];
                // Scale SVG to fit thumbnail
                const svg = thumb.querySelector('svg');
                if (svg) {
                    const vb = svg.getAttribute('viewBox');
                    if (vb) {
                        const [, , w, h] = vb.split(/\s+/).map(Number);
                        if (w && h) {
                            svg.style.width = '100%';
                            svg.style.height = 'auto';
                            svg.style.aspectRatio = `${w}/${h}`;
                        }
                    }
                }
            }

            const label = el.createDiv({ cls: 'nav-slide-label' });
            label.createSpan({ cls: 'nav-slide-num', text: String(slide.index) });
            label.createSpan({ text: slide.heading });

            el.addEventListener('click', () => {
                this._navigateToLine(slide.line);
            });
        });
    }

    private _navigateToLine(line: number): void {
        if (!this._file) { return; }
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view.file?.path === this._file.path) {
                const editor = view.editor;
                if (editor) {
                    editor.setCursor({ line, ch: 0 });
                    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
                }
                this.app.workspace.setActiveLeaf(leaf);
                return;
            }
        }
    }

    async onClose(): Promise<void> {
        if (this._pendingUpdate) { clearTimeout(this._pendingUpdate); }
    }
}
