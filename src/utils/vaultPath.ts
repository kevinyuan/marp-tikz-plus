import { App, FileSystemAdapter } from 'obsidian';

/**
 * Returns the vault's absolute filesystem path.
 *
 * This plugin is desktop-only (`isDesktopOnly: true` in manifest.json) and
 * needs the real on-disk path for TikZ/LaTeX compilation, include resolution
 * and PPTX/PDF export, none of which are reachable through the vault-relative
 * Obsidian API. `FileSystemAdapter` is the concrete adapter used on desktop.
 */
export function getVaultBasePath(app: App): string {
    const adapter = app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
        return adapter.getBasePath();
    }
    throw new Error('MarpTikz requires a local filesystem vault (desktop only).');
}
