import { App, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import type MarpTikzPlugin from '../../main';

export class MarpTikzSettingsTab extends PluginSettingTab {
    constructor(app: App, private readonly plugin: MarpTikzPlugin) {
        super(app, plugin);
    }

    /**
     * Declarative definitions used on Obsidian 1.13.0+ so these settings show
     * up in the app's settings search. `display()` below is kept as the
     * imperative fallback for the 1.7.2–1.12.x range this plugin still
     * supports (declarative rendering only takes over when this returns a
     * non-empty array).
     */
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: 'Invert colors in dark mode',
                desc: 'Automatically invert diagram colors when using a dark theme.',
                control: { type: 'toggle', key: 'invertColorsInDarkMode' },
            },
            {
                name: 'Render timeout (ms)',
                desc: 'Maximum time to wait for a diagram to render. Increase for complex diagrams.',
                control: { type: 'slider', key: 'renderTimeout', min: 1000, max: 60000, step: 1000 },
            },
            {
                type: 'group',
                heading: 'Marp export',
                items: [
                    {
                        name: 'Include speaker notes in PPTX',
                        desc: 'Include speaker notes (HTML comments <!-- ... -->) when exporting Marp slides to PPTX.',
                        control: { type: 'toggle', key: 'marpPptxNotes' },
                    },
                ],
            },
        ];
    }

    getControlValue(key: string): unknown {
        return (this.plugin.settings as unknown as Record<string, unknown>)[key];
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
        await this.plugin.saveSettings();
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
