import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { Marp } from '@marp-team/marp-core';
import * as path from 'path';
import { isMarpFile, parseSpeakerNotes } from './slideParser';
import { generateHash } from '../utils/hash';
import { renderNotesMarkdown, escapeHtml as _escapeHtml } from '../utils/notesMarkdown';
import { resolveLocalResources, toVaultRelative } from '../utils/resolveResources';
import { getVaultBasePath } from '../utils/vaultPath';
import { setSanitizedHtml } from '../utils/sanitizeHtml';
import { MarpStyleSheet } from '../utils/marpStyleSheet';
import type MarpTikzPlugin from '../../main';

export const MARP_VIEW_TYPE = 'marp-tikz-preview';

// Kept in sync with the .marp-thumb-slide rule in styles.css.
const SLIDE_W = 1280;
const SLIDE_H = 720;
const SIDEBAR_WIDTHS = { small: 172, big: 232, outline: 232 } as const;
type ViewMode = 'small' | 'big' | 'outline';

export class MarpView extends ItemView {
    private _file: TFile | null = null;
    private _pendingUpdate: number | null = null;

    // Sidebar state (persisted across re-renders)
    private _sidebarVisible = true;
    private _viewMode: ViewMode = 'small';
    private _notesVisible = false;
    private _notesHeight = 150;
    private _currentSlideIdx = 0;

    // Keyboard nav cleanup (re-attached on each render)
    private _keyNavCleanup: (() => void) | null = null;

    private readonly _marpStyles = new MarpStyleSheet();

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

    toggleNavigator(): void {
        const sidebar = this.contentEl.querySelector<HTMLElement>('.marp-sidebar');
        const toggleBtn = this.contentEl.querySelector<HTMLElement>('.marp-sidebar-toggle');
        if (!sidebar) { return; }
        this._sidebarVisible = !this._sidebarVisible;
        sidebar.classList.toggle('collapsed', !this._sidebarVisible);
        if (this._sidebarVisible) {
            sidebar.style.width = SIDEBAR_WIDTHS[this._viewMode] + 'px';
        }
        toggleBtn?.classList.toggle('hidden', this._sidebarVisible);
    }

    toggleNotes(): void {
        const notesPanel = this.contentEl.querySelector<HTMLElement>('.marp-notes-panel');
        const notesBtn = this.contentEl.querySelector<HTMLElement>('.marp-toolbar-btn[title="Speaker notes"]');
        if (!notesPanel) { return; }
        this._notesVisible = !this._notesVisible;
        notesPanel.classList.toggle('collapsed', !this._notesVisible);
        notesBtn?.classList.toggle('active', this._notesVisible);
    }

    /**
     * Point local image references at vault resource URLs.
     *
     * Marp HTML is injected into the Obsidian document, so a relative path would
     * resolve against Obsidian's own app URL and the image would not load. The
     * resource URL also carries the file's modification time, so a regenerated
     * image is re-fetched rather than served from cache.
     */
    private _resolveImages(html: string, baseDir: string): string {
        const absBase = getVaultBasePath(this.app);
        const adapter = this.app.vault.adapter;
        return resolveLocalResources(html, (rel) => {
            // Outside the vault Obsidian cannot serve the file, so leave it alone.
            const vaultPath = toVaultRelative(absBase, baseDir, rel);
            if (vaultPath === null) { return null; }
            try {
                return adapter.getResourcePath(vaultPath);
            } catch {
                return null;
            }
        });
    }

    private _scheduleUpdate(): void {
        if (this._pendingUpdate) { window.clearTimeout(this._pendingUpdate); }
        this._pendingUpdate = window.setTimeout(() => {
            this._pendingUpdate = null;
            this._render().catch(e => console.error('[MarpView]', e));
        }, 300);
    }

    private async _render(): Promise<void> {
        // Remove previous keyboard nav listener before rebuilding DOM
        if (this._keyNavCleanup) { this._keyNavCleanup(); this._keyNavCleanup = null; }

        if (!this._file) { return; }
        const rawContent = await this.app.vault.read(this._file);

        const absBase = getVaultBasePath(this.app);
        const baseDir = path.dirname(path.join(absBase, this._file.path));
        const resolver = this.plugin.markdownIncludeResolver;
        resolver.clearTracked();
        const content = resolver.resolve(rawContent, baseDir);
        this.plugin.updateMarpIncludeWatchers(this._file.path, resolver.getTrackedPaths(), this._file);

        if (!isMarpFile(content)) {
            this.contentEl.empty();
            this.contentEl.createEl('p', {
                text: 'Not a Marp file (add marp: true to frontmatter).',
                cls: 'marp-tikz-placeholder'
            });
            return;
        }

        const marp = new Marp({ html: true });

        // Substitute cached TikZ SVGs; kick off rendering for uncached blocks
        const tikzRe = /```tikz\s*\n([\s\S]*?)```/g;
        const uncached: Array<{ hash: string; source: string }> = [];
        const processedContent = content.replace(tikzRe, (_match: string, raw: string) => {
            // Resolve %!include directives so the hash matches the normal markdown preview path
            let source = raw.trim();
            const includeResult = this.plugin.parser.includeResolver.resolve(source, baseDir);
            if (includeResult?.ok) { source = includeResult.value.content; }

            const hash = generateHash(source);
            const entry = this.plugin.renderer.getSvg(hash);
            if (entry?.svg) {
                return `<div class="tikz-in-marp">${entry.svg}</div>`;
            }
            if (entry?.error) {
                return `<div class="tikz-error tikz-in-marp"><div class="tikz-error-title">⚠ TikZ Error</div><pre class="tikz-error-message">${_escapeHtml(entry.error)}</pre></div>`;
            }
            uncached.push({ hash, source });
            return `<div class="tikz-placeholder">⏳ Rendering TikZ…</div>`;
        });

        if (uncached.length > 0) {
            this.plugin.renderer
                .renderBlocks(uncached, () => this._scheduleUpdate())
                .then(() => this._scheduleUpdate())
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
        html = this._resolveImages(html, baseDir);

        const notes = parseSpeakerNotes(content);

        // ── Build DOM ─────────────────────────────────────────────────────────
        this.contentEl.empty();
        this.contentEl.addClass('marp-tikz-view');

        // Marp's per-file theme CSS changes with the file's frontmatter, so it
        // can't live in the static styles.css — apply it via a constructed
        // stylesheet instead of an injected <style> element.
        this._marpStyles.update(css);

        // ── Toggle button (shown when sidebar is collapsed) ────────────────
        const toggleBtn = this.contentEl.createDiv({ cls: 'marp-sidebar-toggle', text: '☰' });
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
        sidebar.setAttribute('tabindex', '0');

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
            setSanitizedHtml(btn, modeIcons[mode]);
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

        // Speaker notes toggle — horizontal-split panel icon
        const notesBtn = toolbar.createEl('button', { cls: 'marp-toolbar-btn' + (this._notesVisible ? ' active' : '') });
        setSanitizedHtml(notesBtn, '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="13" x2="21" y2="13"/></svg>');
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
        setSanitizedHtml(scrollArea, html);  // renders div.marpit with all SVGs

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
            const rawNote = notes[this._currentSlideIdx] ?? '';
            if (!rawNote) {
                notesContent.empty();
            } else {
                let rendered: string;
                try {
                    rendered = renderNotesMarkdown(rawNote);
                } catch {
                    rendered = '';
                }
                if (rendered) {
                    setSanitizedHtml(notesContent, rendered);
                } else {
                    notesContent.empty();
                    notesContent.createEl('pre', { text: rawNote });
                }
            }
        };
        if (this._notesVisible) { updateNotesContent(); }

        // ── Keyboard navigation ───────────────────────────────────────────
        const navigateSlide = (delta: number) => {
            const allSlides = scrollArea.querySelectorAll<SVGElement>('svg[data-marpit-svg]');
            if (!allSlides.length) { return; }
            const newIdx = Math.max(0, Math.min(this._currentSlideIdx + delta, allSlides.length - 1));
            if (newIdx === this._currentSlideIdx) { return; }
            this._currentSlideIdx = newIdx;
            const selector = this._viewMode === 'outline' ? '.marp-outline-item' : '.marp-thumb';
            sidebar.querySelectorAll(selector).forEach((el, j) => el.classList.toggle('active', j === newIdx));
            const item = sidebar.querySelectorAll<HTMLElement>(selector)[newIdx];
            item?.scrollIntoView({ block: 'nearest' });
            allSlides[newIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
            updateNotesContent();
        };

        // Sidebar: arrow up/down navigates when sidebar has focus
        sidebar.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return; }
            e.preventDefault();
            navigateSlide(e.key === 'ArrowDown' ? 1 : -1);
        });

        // View-level: arrow keys work when focus is anywhere inside the view
        // (but not inside the sidebar itself — that has its own handler above)
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return; }
            if (sidebar.contains(document.activeElement)) { return; }
            const tag = (document.activeElement as HTMLElement | null)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return; }
            const allSlides = scrollArea.querySelectorAll('svg[data-marpit-svg]');
            if (!allSlides.length) { return; }
            e.preventDefault();
            navigateSlide(e.key === 'ArrowDown' ? 1 : -1);
        };
        this.contentEl.addEventListener('keydown', keyHandler);
        this._keyNavCleanup = () => this.contentEl.removeEventListener('keydown', keyHandler);

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

                    thumb.createDiv({ cls: 'marp-thumb-num', text: String(i + 1) });

                    if (origSection) {
                        const cs = window.getComputedStyle(origSection);
                        const slideDiv = createDiv({ cls: 'marp-thumb-slide' });
                        slideDiv.style.transform = `scale(${scale})`;
                        // Copy key visual styles so thumbnail matches slide appearance
                        const copyProps = [
                            'backgroundColor', 'backgroundImage', 'backgroundSize',
                            'backgroundPosition', 'backgroundRepeat', 'color', 'fontFamily',
                            'fontSize', 'lineHeight', 'padding', 'display', 'flexDirection',
                            'flexWrap', 'justifyContent', 'alignItems', 'alignContent', 'textAlign',
                            'gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas',
                            'gridAutoColumns', 'gridAutoRows', 'gridAutoFlow',
                            'gridColumn', 'gridRow', 'gridArea',
                            'gap', 'columnGap', 'rowGap',
                            'columnCount', 'columnWidth',
                        ] as const satisfies readonly (keyof CSSStyleDeclaration)[];
                        copyProps.forEach(p => { slideDiv.style[p] = cs[p]; });

                        // cloneNode preserves SVG namespaces (innerHTML round-trip can corrupt them)
                        origSection.childNodes.forEach(child => {
                            slideDiv.appendChild(child.cloneNode(true));
                        });
                        this._copyStyles(origSection, slideDiv, 10);

                        const viewport = createDiv({ cls: 'marp-thumb-viewport' });
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
        window.requestAnimationFrame(() => rebuildSidebarContent());
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
            const props = [
                'color', 'backgroundColor', 'backgroundImage', 'backgroundSize',
                'backgroundPosition', 'backgroundRepeat',
                'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
                'lineHeight', 'textAlign', 'letterSpacing', 'wordSpacing', 'textDecoration',
                'margin', 'padding',
                'display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent',
                'gridTemplateColumns', 'gridTemplateRows', 'gridTemplateAreas',
                'gridAutoColumns', 'gridAutoRows', 'gridAutoFlow',
                'gridColumn', 'gridRow', 'gridArea',
                'gap', 'columnGap', 'rowGap',
                'columnCount', 'columnWidth',
                'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
                'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
                'borderCollapse', 'borderSpacing',
                'listStyleType', 'listStylePosition',
                'opacity', 'verticalAlign', 'whiteSpace', 'overflow',
            ] as const satisfies readonly (keyof CSSStyleDeclaration)[];
            props.forEach(p => {
                const v = cs[p];
                if (v) { ce.style[p] = v; }
            });
            if (oe.children.length > 0) { this._copyStyles(oe, ce, maxDepth - 1); }
        }
    }

    async onClose(): Promise<void> {
        if (this._pendingUpdate) { window.clearTimeout(this._pendingUpdate); }
        if (this._keyNavCleanup) { this._keyNavCleanup(); this._keyNavCleanup = null; }
        this._marpStyles.detach();
    }
}
