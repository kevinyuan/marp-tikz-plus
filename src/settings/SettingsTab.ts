import { App, PluginSettingTab, Setting } from 'obsidian';
import type MarpTikzPlugin from '../../main';

export class MarpTikzSettingsTab extends PluginSettingTab {
    constructor(app: App, private readonly plugin: MarpTikzPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Invert colors in dark mode')
            .setDesc('Automatically invert diagram colors when using a dark theme.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.invertColorsInDarkMode)
                .onChange(async (value) => {
                    this.plugin.settings.invertColorsInDarkMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Render timeout (ms)')
            .setDesc('Maximum time to wait for a diagram to render. Increase for complex diagrams.')
            .addSlider(slider => slider
                .setLimits(1000, 60000, 1000)
                .setValue(this.plugin.settings.renderTimeout)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.renderTimeout = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('Marp export').setHeading();

        new Setting(containerEl)
            .setName('Include speaker notes in PPTX')
            .setDesc('Include speaker notes (HTML comments <!-- ... -->) when exporting Marp slides to PPTX.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.marpPptxNotes)
                .onChange(async (value) => {
                    this.plugin.settings.marpPptxNotes = value;
                    await this.plugin.saveSettings();
                }));
    }
}
