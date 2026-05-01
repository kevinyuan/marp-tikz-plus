export interface MarpTikzSettings {
    invertColorsInDarkMode: boolean;
    renderTimeout: number;
    marpPptxNotes: boolean;
    exportFormat: 'pptx' | 'pdf';
    cacheVersion: number;
}

export const DEFAULT_SETTINGS: MarpTikzSettings = {
    invertColorsInDarkMode: true,
    renderTimeout: 60000,
    marpPptxNotes: true,
    exportFormat: 'pptx',
    cacheVersion: 1,
};
