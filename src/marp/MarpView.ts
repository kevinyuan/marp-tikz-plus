import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { isMarpFile, parseSpeakerNotes } from './slideParser';
import { generateHash } from '../utils/hash';
import type MarpTikzPlugin from '../../main';

export const MARP_VIEW_TYPE = 'marp-tikz-preview';

const SLIDE_W = 1280;
const SLIDE_H = 720;
const SIDEBAR_WIDTHS = { small: 172, big: 232, outline: 232 } as const;
type ViewMode = 'small' | 'big' | 'outline';

export class MarpView extends ItemView {
    private _file: TFile | null = null;
    private _pendingUpdate: ReturnType<typeof setTimeout> | null = null;

    // Sidebar state (persisted across re-renders)
    private _sidebarVisible = true;
    private _viewMode: ViewMode = 'small';
    private _notesVisible = false;
    private _notesHeight = 150;
    private _currentSlideIdx = 0;

    constructor(leaf: WorkspaceLeaf, private readonly plugin: MarpTikzPlugin) {
        super(leaf);
    }

    getViewType(): string { return MARP_VIEW_TYPE; }
    getDisplayText(): string { return this._file ? `Marp: ${this._file.basename}` : 'Marp Preview'; }
    getIcon(): string { return 'presentation'; }

    async onOpen(): Promise<void> {
        this.contentEl.addClass('marp-tikz-view');
        this.contentEl.createEl('p', {
            text: 'Open a Marp markdown file and run "Open Marp Preview" to view slides here.',
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

        // Substitute cached TikZ SVGs; kick off rendering for uncached blocks
        const tikzRe = /```tikz\s*\n([\s\S]*?)```/g;
        const uncached: Array<{ hash: string; source: string }> = [];
        const processedContent = content.replace(tikzRe, (_match: string, raw: string) => {
            const source = raw.trim();
            const hash = generateHash(source);
            const entry = this.plugin.renderer.getSvg(hash);
            if (entry?.svg) {
                return `<div class="tikz-in-marp">${entry.svg}</div>`;
            }
            uncached.push({ hash, source });
            return `<div class="tikz-placeholder">⏳ Rendering TikZ…</div>`;
        });

        if (uncached.length > 0) {
            this.plugin.renderer
                .renderBlocks(uncached, () => this._scheduleUpdate())
                .catch(e => console.error('[MarpView] TikZ render error', e));
        }

        let html: string, css: string;
        try {
            ({ html, css } = marp.render(processedContent));
        } catch (e) {
            new Notice('Marp render error: ' + (e as Error).message);
            return;
        }
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '');

        const notes = parseSpeakerNotes(content);

        // ── Build DOM ─────────────────────────────────────────────────────────
        this.contentEl.empty();
        this.contentEl.addClass('marp-tikz-view');

        // ── Styles (Marp CSS + our layout) ─────────────────────────────────
        const style = this.contentEl.createEl('style');
        style.textContent = css + `
/* ── Layout ─────────────────────────────────────────────────────────────── */
.marp-tikz-view {
    display: flex; flex-direction: column;
    height: 100%; overflow: hidden;
    background: var(--background-secondary);
    position: relative;
}
/* Toggle button (hamburger, shows when sidebar is hidden) */
.marp-sidebar-toggle {
    position: absolute; top: 8px; left: 8px; z-index: 20;
    width: 28px; height: 28px; display: flex;
    align-items: center; justify-content: center;
    cursor: pointer;
    background: var(--background-modifier-box-shadow);
    color: var(--text-normal);
    border-radius: 4px; font-size: 14px;
    opacity: 0.7; transition: opacity 0.15s; user-select: none;
}
.marp-sidebar-toggle:hover { opacity: 1; }
.marp-sidebar-toggle.hidden { display: none; }

/* Body: sidebar + main */
.marp-body { display: flex; flex: 1; overflow: hidden; }

/* Sidebar */
.marp-sidebar {
    flex-shrink: 0; overflow-y: auto; overflow-x: hidden;
    background: var(--background-primary);
    border-right: 1px solid var(--background-modifier-border);
    transition: width 0.15s;
}
.marp-sidebar.collapsed { width: 0 !important; border-right: none; }

/* Toolbar inside sidebar */
.marp-sidebar-toolbar {
    position: sticky; top: 0; z-index: 3;
    display: flex; gap: 2px; padding: 6px 4px;
    background: var(--background-primary);
    border-bottom: 1px solid var(--background-modifier-border);
}
.marp-toolbar-btn {
    flex: 0 0 24px; width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: 3px; cursor: pointer;
    background: transparent;
    color: var(--text-normal); opacity: 0.6;
    font-size: 13px; transition: opacity 0.15s, background 0.15s;
    padding: 0;
}
.marp-toolbar-btn:hover { opacity: 1; background: var(--background-modifier-hover); }
.marp-toolbar-btn.active { opacity: 1; background: var(--background-modifier-active-hover); }
.marp-toolbar-spacer { flex: 1; }

/* Thumbnails */
.marp-thumb {
    position: relative; cursor: pointer; margin: 0 8px 6px;
    border-radius: 3px; overflow: hidden;
    border: 2px solid transparent; transition: border-color 0.15s;
}
.marp-thumb:hover { border-color: var(--interactive-accent); }
.marp-thumb.active { border-color: var(--interactive-accent); }
.marp-thumb-num {
    position: absolute; top: 2px; left: 4px;
    font-size: 9px; font-weight: bold; color: #fff;
    background: rgba(0,0,0,0.55); border-radius: 2px;
    padding: 0 3px; z-index: 2; line-height: 1.5;
    font-family: system-ui, sans-serif;
}
.marp-thumb-viewport { overflow: hidden; position: relative; }
.marp-thumb-slide {
    position: absolute; top: 0; left: 0;
    width: ${SLIDE_W}px; height: ${SLIDE_H}px;
    overflow: hidden; box-sizing: border-box;
    transform-origin: 0 0;
}

/* Outline mode */
.marp-outline-item {
    cursor: pointer; padding: 4px 8px; border-radius: 3px; margin: 0 4px 2px;
    font-size: 12px; line-height: 1.6;
    color: var(--text-normal);
    display: flex; align-items: baseline; gap: 6px;
    transition: background 0.1s;
}
.marp-outline-item:hover { background: var(--background-modifier-hover); }
.marp-outline-item.active { background: var(--interactive-accent); color: var(--text-on-accent); }
.marp-outline-num { opacity: 0.5; font-size: 11px; min-width: 16px; }
.marp-outline-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Right column: slides + notes stacked vertically */
.marp-right-col { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

/* Main slide scroll area */
.marp-scroll-area { flex: 1; overflow-y: auto; padding: 16px; }

/* Slides: each SVG scales to container width (SVG viewBox handles the rest) */
.marp-scroll-area svg[data-marpit-svg] {
    width: 100%; height: auto; display: block;
    margin-bottom: 16px;
    box-shadow: 0 2px 14px rgba(0,0,0,.3); border-radius: 4px;
}
.marp-tikz-view .tikz-in-marp svg { max-width: 100%; height: auto; }

/* Speaker notes — bottom panel */
.marp-notes-panel {
    flex-shrink: 0;
    display: flex; flex-direction: column;
    background: var(--background-primary);
    border-top: 1px solid var(--background-modifier-border);
    font-size: 13px; line-height: 1.5; color: var(--text-normal);
}
.marp-notes-panel.collapsed { display: none; }
.marp-notes-resize {
    flex-shrink: 0; height: 5px; cursor: ns-resize;
    background: transparent; transition: background 0.15s;
}
.marp-notes-resize:hover, .marp-notes-resize.dragging {
    background: var(--interactive-accent);
}
.marp-notes-inner { flex: 1; overflow-y: auto; padding: 4px 16px 8px; }
.marp-notes-header {
    font-size: 11px; font-weight: bold; opacity: 0.5;
    margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;
}
.marp-notes-content { white-space: pre-wrap; }
        `;

        // ── Toggle button (shown when sidebar is collapsed) ────────────────
        const toggleBtn = this.contentEl.createDiv({ cls: 'marp-sidebar-toggle' });
        toggleBtn.innerHTML = '☰';
        toggleBtn.title = 'Show slide navigator';
        if (this._sidebarVisible) { toggleBtn.addClass('hidden'); }
        toggleBtn.addEventListener('click', () => {
            this._sidebarVisible = true;
            sidebar.classList.remove('collapsed');
            sidebar.style.width = SIDEBAR_WIDTHS[this._viewMode] + 'px';
            toggleBtn.addClass('hidden');
        });

        // ── Body ──────────────────────────────────────────────────────────
        const body = this.contentEl.createDiv({ cls: 'marp-body' });

        // ── Sidebar ──────────────────────────────────────────────────────
        const sidebar = body.createDiv({ cls: 'marp-sidebar' });
        sidebar.style.width = SIDEBAR_WIDTHS[this._viewMode] + 'px';
        if (!this._sidebarVisible) { sidebar.addClass('collapsed'); }

        // Toolbar
        const toolbar = sidebar.createDiv({ cls: 'marp-sidebar-toolbar' });

        const modeIcons: Record<ViewMode, string> = {
            small:   '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8"/></svg>',
            big:     '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1" width="12" height="12"/></svg>',
            outline: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="1" y1="3.5" x2="13" y2="3.5"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10.5" x2="13" y2="10.5"/></svg>',
        };
        const modeTitles: Record<ViewMode, string> = { small: 'Small thumbnails', big: 'Large thumbnails', outline: 'Outline' };
        const modeBtns: Partial<Record<ViewMode, HTMLElement>> = {};
        (['small', 'big', 'outline'] as ViewMode[]).forEach(mode => {
            const btn = toolbar.createEl('button', { cls: 'marp-toolbar-btn' });
            btn.innerHTML = modeIcons[mode];
            btn.title = modeTitles[mode];
            if (this._viewMode === mode) { btn.addClass('active'); }
            btn.addEventListener('click', () => {
                this._viewMode = mode;
                sidebar.style.width = SIDEBAR_WIDTHS[mode] + 'px';
                Object.entries(modeBtns).forEach(([m, b]) => b?.classList.toggle('active', m === mode));
                rebuildSidebarContent();
            });
            modeBtns[mode] = btn;
        });

        // Speaker notes toggle
        const notesBtn = toolbar.createEl('button', { cls: 'marp-toolbar-btn' + (this._notesVisible ? ' active' : '') });
        notesBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/></svg>';
        notesBtn.title = 'Speaker notes';
        notesBtn.addEventListener('click', () => {
            this._notesVisible = !this._notesVisible;
            notesBtn.classList.toggle('active', this._notesVisible);
            notesPanel.classList.toggle('collapsed', !this._notesVisible);
            if (this._notesVisible) { updateNotesContent(); }
        });

        toolbar.createDiv({ cls: 'marp-toolbar-spacer' });

        // Close / collapse sidebar button
        const closeBtn = toolbar.createEl('button', { cls: 'marp-toolbar-btn' });
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close navigator';
        closeBtn.addEventListener('click', () => {
            this._sidebarVisible = false;
            sidebar.classList.add('collapsed');
            toggleBtn.removeClass('hidden');
        });

        // ── Right column: slides + notes ─────────────────────────────────
        const rightCol = body.createDiv({ cls: 'marp-right-col' });

        // ── Scroll area (main slides) ─────────────────────────────────────
        const scrollArea = rightCol.createDiv({ cls: 'marp-scroll-area' });
        scrollArea.innerHTML = html;  // renders div.marpit with all SVGs

        // ── Speaker notes panel (bottom of right column only) ────────────
        const notesPanel = rightCol.createDiv({ cls: 'marp-notes-panel' + (this._notesVisible ? '' : ' collapsed') });
        notesPanel.style.height = this._notesHeight + 'px';

        const resizeHandle = notesPanel.createDiv({ cls: 'marp-notes-resize' });
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = this._notesHeight;
            resizeHandle.addClass('dragging');
            const onMove = (e: MouseEvent) => {
                const newH = Math.round(Math.max(60, Math.min(400, startH + startY - e.clientY)));
                this._notesHeight = newH;
                notesPanel.style.height = newH + 'px';
            };
            const onUp = () => {
                resizeHandle.removeClass('dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        const notesInner = notesPanel.createDiv({ cls: 'marp-notes-inner' });
        const notesHeader = notesInner.createDiv({ cls: 'marp-notes-header', text: 'Speaker Notes' });
        const notesContent = notesInner.createDiv({ cls: 'marp-notes-content' });

        const updateNotesContent = () => {
            notesHeader.textContent = `Speaker Notes — Slide ${this._currentSlideIdx + 1}`;
            notesContent.textContent = notes[this._currentSlideIdx] ?? '';
            if (!notesContent.textContent) {
                notesContent.style.cssText = 'opacity:0.4;font-style:italic';
                notesContent.textContent = 'No speaker notes for this slide.';
            } else {
                notesContent.style.cssText = '';
            }
        };
        if (this._notesVisible) { updateNotesContent(); }

        // ── Build sidebar content ──────────────────────────────────────────
        // We need to wait one frame so the Marp SVGs are in the DOM and
        // getComputedStyle works on foreignObject > section elements.
        const rebuildSidebarContent = () => {
            // Remove old content items (keep toolbar)
            Array.from(sidebar.children).forEach(c => { if (c !== toolbar) { c.remove(); } });

            const slides = scrollArea.querySelectorAll<SVGElement>('svg[data-marpit-svg]');
            if (slides.length === 0) { return; }

            if (this._viewMode === 'outline') {
                slides.forEach((slide, i) => {
                    const section = slide.querySelector('foreignObject > section');
                    const h = section?.querySelector('h1,h2,h3,h4,h5,h6');
                    const heading = h?.textContent?.trim() || `Slide ${i + 1}`;
                    const item = sidebar.createDiv({ cls: 'marp-outline-item' + (i === this._currentSlideIdx ? ' active' : '') });
                    item.createSpan({ cls: 'marp-outline-num', text: String(i + 1) });
                    item.createSpan({ cls: 'marp-outline-label', text: heading });
                    item.title = heading;
                    item.addEventListener('click', () => {
                        slide.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        this._currentSlideIdx = i;
                        sidebar.querySelectorAll('.marp-outline-item').forEach((el, j) => el.classList.toggle('active', j === i));
                        updateNotesContent();
                    });
                });
            } else {
                const isLarge = this._viewMode === 'big';
                const thumbW = isLarge ? 196 : 136;
                const thumbH = Math.round(thumbW * SLIDE_H / SLIDE_W);
                const scale = thumbW / SLIDE_W;

                slides.forEach((slide, i) => {
                    const origSection = slide.querySelector<HTMLElement>('foreignObject > section');
                    const thumb = sidebar.createDiv({ cls: 'marp-thumb' + (i === this._currentSlideIdx ? ' active' : '') });
                    thumb.title = `Slide ${i + 1}`;

                    const numBadge = thumb.createDiv({ cls: 'marp-thumb-num', text: String(i + 1) });
                    numBadge.style.cssText = ''; // override any inherited styles

                    if (origSection) {
                        const cs = window.getComputedStyle(origSection);
                        const slideDiv = document.createElement('div');
                        slideDiv.className = 'marp-thumb-slide';
                        slideDiv.style.transform = `scale(${scale})`;
                        // Copy key visual styles so thumbnail matches slide appearance
                        const copyProps = ['backgroundColor','backgroundImage','backgroundSize',
                            'backgroundPosition','backgroundRepeat','color','fontFamily',
                            'fontSize','lineHeight','padding','display','flexDirection',
                            'flexWrap','justifyContent','alignItems','textAlign'] as const;
                        copyProps.forEach(p => { (slideDiv.style as any)[p] = cs[p]; });
                        slideDiv.innerHTML = origSection.innerHTML;
                        this._copyStyles(origSection, slideDiv, 5);

                        const viewport = document.createElement('div');
                        viewport.className = 'marp-thumb-viewport';
                        viewport.style.width = thumbW + 'px';
                        viewport.style.height = thumbH + 'px';
                        viewport.appendChild(slideDiv);
                        thumb.appendChild(viewport);
                    }

                    thumb.addEventListener('click', () => {
                        slide.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        this._currentSlideIdx = i;
                        sidebar.querySelectorAll('.marp-thumb').forEach((el, j) => el.classList.toggle('active', j === i));
                        updateNotesContent();
                    });
                });
            }
        };

        // Scroll tracking: highlight active thumbnail when user scrolls slides
        const slides = Array.from(scrollArea.querySelectorAll<SVGElement>('svg[data-marpit-svg]'));
        const io = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) { return; }
                const idx = slides.indexOf(entry.target as SVGElement);
                if (idx < 0 || idx === this._currentSlideIdx) { return; }
                this._currentSlideIdx = idx;
                const selector = this._viewMode === 'outline' ? '.marp-outline-item' : '.marp-thumb';
                sidebar.querySelectorAll(selector).forEach((el, j) => el.classList.toggle('active', j === idx));
                updateNotesContent();
            });
        }, { root: scrollArea, threshold: 0.5 });
        slides.forEach(s => io.observe(s));

        // Build thumbnails after one frame so getComputedStyle has values
        requestAnimationFrame(() => rebuildSidebarContent());
    }

    /** Recursively copy computed styles from orig to clone (mirrors original marp-thumbnails.js). */
    private _copyStyles(orig: Element, clone: Element, maxDepth: number): void {
        if (maxDepth <= 0) { return; }
        const origChildren = orig.children;
        const cloneChildren = clone.children;
        for (let i = 0; i < origChildren.length && i < cloneChildren.length; i++) {
            const oe = origChildren[i] as HTMLElement;
            const ce = cloneChildren[i] as HTMLElement;
            if (ce.nodeType !== 1) { continue; }
            const cs = window.getComputedStyle(oe);
            const props = ['color','backgroundColor','backgroundImage','backgroundSize',
                'backgroundPosition','display','flexDirection','flexWrap',
                'justifyContent','alignItems','fontSize','fontFamily',
                'fontWeight','fontStyle','lineHeight','textAlign',
                'padding','margin','opacity'] as const;
            props.forEach(p => {
                const v = cs[p as keyof CSSStyleDeclaration] as string;
                if (v) { (ce.style as any)[p] = v; }
            });
            if (oe.children.length > 0) { this._copyStyles(oe, ce, maxDepth - 1); }
        }
    }

    async onClose(): Promise<void> {
        if (this._pendingUpdate) { clearTimeout(this._pendingUpdate); }
    }
}
