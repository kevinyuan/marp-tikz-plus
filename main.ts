import { Plugin, MarkdownPostProcessorContext, TFile, Notice, WorkspaceLeaf } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs';

import { DocumentParser } from './src/core/DocumentParser';
import { CacheManager } from './src/core/CacheManager';
import { TikzRenderer } from './src/renderer/TikzRenderer';
import { MarpTikzSettings, DEFAULT_SETTINGS } from './src/settings/types';
import { MarpTikzSettingsTab } from './src/settings/SettingsTab';
import { isMarpFile } from './src/marp/slideParser';
import { MarpView, MARP_VIEW_TYPE } from './src/marp/MarpView';

export default class MarpTikzPlugin extends Plugin {
    settings!: MarpTikzSettings;
    renderer!: TikzRenderer;

    private parser!: DocumentParser;
    private cacheManager!: CacheManager;
    private includeWatchers = new Map<string, fs.FSWatcher>();
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    async onload(): Promise<void> {
        await this.loadSettings();

        this.parser = new DocumentParser();
        this.cacheManager = new CacheManager(
            (data) => this.saveData({ cache: data, settings: this.settings }),
            async () => {
                const saved = await this.loadData();
                return saved?.cache ?? null;
            }
        );
        this.renderer = new TikzRenderer(
            this.cacheManager,
            () => this.settings.renderTimeout,
            () => document.body.classList.contains('theme-dark'),
            (msg) => console.log('[MarpTikz]', msg),
        );

        this.addSettingTab(new MarpTikzSettingsTab(this.app, this));

        // Register views
        this.registerView(MARP_VIEW_TYPE, (leaf) => new MarpView(leaf, this));

        // Register TikZ markdown post-processor
        this.registerMarkdownPostProcessor(
            (el, ctx) => this._processTikzBlocks(el, ctx),
            100
        );

        this._registerCommands();
        this._registerEventHandlers();

        console.log('[MarpTikz] Plugin loaded');
    }

    onunload(): void {
        for (const w of this.includeWatchers.values()) { w.close(); }
        this.includeWatchers.clear();
        for (const t of this.debounceTimers.values()) { clearTimeout(t); }
        this.debounceTimers.clear();
    }

    async loadSettings(): Promise<void> {
        const saved = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, saved?.settings ?? {});
    }

    async saveSettings(): Promise<void> {
        const existing = await this.loadData();
        await this.saveData({ ...existing, settings: this.settings });
    }

    // ── TikZ markdown post-processor ──────────────────────────────────────────

    private _processTikzBlocks(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
        const codeBlocks = el.querySelectorAll('code.language-tikz');
        if (codeBlocks.length === 0) { return; }

        const filePath = ctx.sourcePath
            ? this.app.vault.getAbstractFileByPath(ctx.sourcePath)?.path ?? ctx.sourcePath
            : '';
        const absPath = filePath
            ? path.join((this.app.vault.adapter as any).basePath, filePath)
            : '';

        codeBlocks.forEach((codeEl) => {
            const pre = codeEl.parentElement;
            if (!pre) { return; }

            const rawSource = codeEl.textContent ?? '';
            const source = this._resolveInclude(rawSource, absPath);
            if (source === null) {
                // Include error — show error block
                const errDiv = document.createElement('div');
                errDiv.className = 'tikz-error';
                errDiv.innerHTML = `<div class="tikz-error-title">⚠ Include Error</div><pre class="tikz-error-message">${escapeHtml(rawSource)}</pre>`;
                pre.replaceWith(errDiv);
                return;
            }

            const hash = require('./src/utils/hash').generateHash(source.trim());
            const cached = this.renderer.getSvg(hash);

            if (cached?.svg) {
                const div = document.createElement('div');
                div.className = 'tikz-diagram';
                div.innerHTML = cached.svg;
                pre.replaceWith(div);
            } else if (cached?.error) {
                const errDiv = document.createElement('div');
                errDiv.className = 'tikz-error';
                errDiv.innerHTML = `<div class="tikz-error-title">⚠ Rendering Error</div><pre class="tikz-error-message">${escapeHtml(cached.error)}</pre>
                    <button class="tikz-retry">Retry</button>`;
                errDiv.querySelector('.tikz-retry')?.addEventListener('click', () => {
                    this._retryBlock(hash, source, errDiv);
                });
                pre.replaceWith(errDiv);
            } else {
                const spinner = document.createElement('div');
                spinner.className = 'tikz-loading';
                spinner.textContent = '⏳ Rendering TikZ diagram…';
                pre.replaceWith(spinner);

                // Trigger background render
                this._scheduleRender(filePath, absPath);
            }
        });
    }

    private _resolveInclude(source: string, absFilePath: string): string | null {
        const baseDir = absFilePath ? path.dirname(absFilePath) : process.cwd();
        const result = this.parser.includeResolver.resolve(source, baseDir);
        if (!result) { return source; }
        if (result.ok) { return result.value.content; }
        return null;
    }

    private _scheduleRender(filePath: string, absFilePath: string): void {
        const key = filePath;
        const existing = this.debounceTimers.get(key);
        if (existing) { return; }

        const timer = setTimeout(async () => {
            this.debounceTimers.delete(key);
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) { return; }
            const content = await this.app.vault.read(file);
            const blocks = this.parser.parse(content, absFilePath);
            if (blocks.length === 0) { return; }

            await this.renderer.renderBlocks(blocks, () => {
                // Refresh the markdown view after each block renders
                this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
                    const view = leaf.view as any;
                    if (view.file?.path === filePath) {
                        // Trigger re-render by re-reading the file
                        view.previewMode?.rerender?.(true);
                    }
                });
            });

            this._updateIncludeWatchers(filePath, absFilePath);
            this._refreshMarpViews(file);
        }, 50);

        this.debounceTimers.set(key, timer);
    }

    private async _retryBlock(hash: string, source: string, el: HTMLElement): Promise<void> {
        this.renderer.clearMemoryCache();
        await this.cacheManager.invalidate(hash);
        el.textContent = '⏳ Retrying…';
        await this.renderer.renderBlocks([{ hash, source }]);
        const cached = this.renderer.getSvg(hash);
        if (cached?.svg) {
            const div = document.createElement('div');
            div.className = 'tikz-diagram';
            div.innerHTML = cached.svg;
            el.replaceWith(div);
        } else {
            el.innerHTML = `<div class="tikz-error-title">⚠ Retry failed</div><pre class="tikz-error-message">${escapeHtml(cached?.error ?? 'Unknown error')}</pre>`;
        }
    }

    private _updateIncludeWatchers(filePath: string, absFilePath: string): void {
        const included = this.parser.getIncludedFiles(absFilePath);
        const key = filePath;

        // Close old watchers for this doc
        const old = this.includeWatchers.get(key);
        if (old) { old.close(); this.includeWatchers.delete(key); }

        for (const fp of included) {
            try {
                const watcher = fs.watch(fp, () => {
                    this.parser.includeResolver.invalidate(fp);
                    this.renderer.clearMemoryCache();
                    const file = this.app.vault.getAbstractFileByPath(filePath);
                    if (file instanceof TFile) { this._scheduleRender(filePath, absFilePath); }
                });
                this.includeWatchers.set(key, watcher);
            } catch { /* ignore */ }
        }
    }

    // ── Marp views ────────────────────────────────────────────────────────────

    private _refreshMarpViews(_file: TFile): void {
        this.app.workspace.getLeavesOfType(MARP_VIEW_TYPE).forEach(leaf => {
            (leaf.view as MarpView).scheduleUpdate();
        });
    }

    private async _openMarpView(file: TFile): Promise<void> {
        const existing = this.app.workspace.getLeavesOfType(MARP_VIEW_TYPE);
        let leaf: WorkspaceLeaf;
        if (existing.length > 0) {
            leaf = existing[0];
        } else {
            leaf = this.app.workspace.getLeaf('split');
        }
        await leaf.setViewState({ type: MARP_VIEW_TYPE, active: true });
        (leaf.view as MarpView).setFile(file);
        this.app.workspace.revealLeaf(leaf);
    }

    private _getMarpView(): MarpView | null {
        const leaves = this.app.workspace.getLeavesOfType(MARP_VIEW_TYPE);
        return leaves.length > 0 ? (leaves[0].view as MarpView) : null;
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    private _registerCommands(): void {
        this.addCommand({
            id: 'open-marp-preview',
            name: 'Open Marp preview',
            callback: async () => {
                const file = this._getActiveMdFile();
                if (!file) { new Notice('Open a Markdown file first.'); return; }
                if (!await this._isMarpFile(file)) { new Notice('Not a Marp file. Add marp: true to frontmatter.'); return; }
                await this._openMarpView(file);
            },
        });

        this.addCommand({
            id: 'toggle-slide-navigator',
            name: 'Toggle Slide Navigator',
            callback: () => {
                const view = this._getMarpView();
                if (!view) { new Notice('Open Marp preview first.'); return; }
                view.toggleNavigator();
            },
        });

        this.addCommand({
            id: 'toggle-speaker-notes',
            name: 'Toggle Speaker Notes',
            callback: () => {
                const view = this._getMarpView();
                if (!view) { new Notice('Open Marp preview first.'); return; }
                view.toggleNotes();
            },
        });

        this.addCommand({
            id: 'export-marp-pptx',
            name: 'Export Marp slides to PPTX',
            callback: async () => {
                const file = this._getActiveMdFile();
                if (!file) { new Notice('Open a Marp Markdown file first.'); return; }
                if (!await this._isMarpFile(file)) { new Notice('Not a Marp file.'); return; }
                await this._runExport(file, 'pptx');
            },
        });

        this.addCommand({
            id: 'export-marp-pdf',
            name: 'Export Marp slides to PDF',
            callback: async () => {
                const file = this._getActiveMdFile();
                if (!file) { new Notice('Open a Marp Markdown file first.'); return; }
                if (!await this._isMarpFile(file)) { new Notice('Not a Marp file.'); return; }
                await this._runExport(file, 'pdf');
            },
        });

        this.addCommand({
            id: 'refresh-diagrams',
            name: 'Refresh TikZ diagrams',
            callback: async () => {
                const file = this._getActiveMdFile();
                if (!file) { return; }
                const absPath = path.join((this.app.vault.adapter as any).basePath, file.path);
                const content = await this.app.vault.read(file);
                const blocks = this.parser.parse(content, absPath);
                for (const b of blocks) { await this.cacheManager.invalidate(b.hash); }
                this.renderer.clearMemoryCache();
                new Notice(`Refreshed ${blocks.length} TikZ diagram(s)`);
                this._scheduleRender(file.path, absPath);
            },
        });

        this.addCommand({
            id: 'clear-cache',
            name: 'Clear TikZ cache',
            callback: async () => {
                const stats = await this.cacheManager.getStats();
                await this.cacheManager.clear();
                this.renderer.clearMemoryCache();
                new Notice(`Cleared ${stats.entryCount} cached diagram(s)`);
            },
        });

        this.addCommand({
            id: 'reset-engine',
            name: 'Reset TikZJax engine',
            callback: async () => {
                await this.renderer.reset();
                new Notice('TikZJax engine reset');
            },
        });

        // Ribbon icon for PPTX export
        this.addRibbonIcon('file-down', 'Export Marp to PPTX', async () => {
            const file = this._getActiveMdFile();
            if (!file) { new Notice('Open a Marp file first.'); return; }
            if (!await this._isMarpFile(file)) { new Notice('Not a Marp file.'); return; }
            await this._runExport(file, 'pptx');
        });
    }

    private async _runExport(file: TFile, format: 'pptx' | 'pdf'): Promise<void> {
        const { PptxExporter } = await import('./src/marp/PptxExporter');
        const absBase = (this.app.vault.adapter as any).basePath;
        const absPath = path.join(absBase, file.path);
        const content = await this.app.vault.read(file);

        const notice = new Notice(`⏳ Exporting to ${format.toUpperCase()}…`, 0);
        const exporter = new PptxExporter(
            this.parser,
            (source: string) => this.renderer.renderTikzToSvg(source),
            (msg: string) => console.log('[PptxExport]', msg),
        );

        try {
            const outputPath = await exporter.export(absPath, content, {
                format,
                includeNotes: this.settings.marpPptxNotes,
                onProgress: (msg: string) => { notice.setMessage(`⏳ ${msg}`); },
            });
            notice.hide();
            new Notice(`✓ Exported: ${path.basename(outputPath)}`);
        } catch (e) {
            notice.hide();
            new Notice(`Export failed: ${(e as Error).message}`, 8000);
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    private _registerEventHandlers(): void {
        // Re-render on file modify with debounce
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') { return; }
            const absBase = (this.app.vault.adapter as any).basePath;
            const absPath = path.join(absBase, file.path);

            const key = file.path;
            const existing = this.debounceTimers.get(key);
            if (existing) { clearTimeout(existing); }

            const timer = setTimeout(async () => {
                this.debounceTimers.delete(key);
                const content = await this.app.vault.read(file);
                const blocks = this.parser.parse(content, absPath);
                if (blocks.length === 0) { return; }
                await this.renderer.renderBlocks(blocks, () => {
                    this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
                        const view = leaf.view as any;
                        if (view.file?.path === file.path) {
                            view.previewMode?.rerender?.(true);
                        }
                    });
                });
                this._updateIncludeWatchers(file.path, absPath);
                this._refreshMarpViews(file);
            }, 1000);

            this.debounceTimers.set(key, timer);
        }));

        // When active file changes, update Marp views
        this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
            if (!leaf) { return; }
            const view = leaf.view as any;
            const file = view?.file;
            if (!(file instanceof TFile) || file.extension !== 'md') { return; }

            this.app.workspace.getLeavesOfType(MARP_VIEW_TYPE).forEach(l => {
                (l.view as MarpView).setFile(file);
            });
        }));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _getActiveMdFile(): TFile | null {
        const file = this.app.workspace.getActiveFile();
        if (file instanceof TFile && file.extension === 'md') { return file; }
        return null;
    }

    private async _isMarpFile(file: TFile): Promise<boolean> {
        const content = await this.app.vault.read(file);
        return isMarpFile(content);
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
