import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { parseSpeakerNotes } from './slideParser';
import { renderNotesMarkdown } from '../utils/notesMarkdown';

export const SPEAKER_NOTES_VIEW_TYPE = 'marp-tikz-speaker-notes';

export class SpeakerNotesView extends ItemView {
    private _file: TFile | null = null;
    private _notes: string[] = [];
    private _currentSlide = 0;

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string { return SPEAKER_NOTES_VIEW_TYPE; }
    getDisplayText(): string { return 'Speaker Notes'; }
    getIcon(): string { return 'message-square'; }

    async onOpen(): Promise<void> {
        this.contentEl.addClass('marp-tikz-speaker-notes');
        this._renderNotes();
    }

    async setFile(file: TFile): Promise<void> {
        this._file = file;
        const content = await file.vault.read(file);
        this._notes = parseSpeakerNotes(content);
        this._currentSlide = 0;
        this._renderNotes();
    }

    async refresh(): Promise<void> {
        if (!this._file) { return; }
        const content = await this._file.vault.read(this._file);
        this._notes = parseSpeakerNotes(content);
        this._renderNotes();
    }

    setCurrentSlide(slideIndex: number): void {
        this._currentSlide = slideIndex;
        this._renderNotes();
    }

    private _renderNotes(): void {
        this.contentEl.empty();

        if (this._notes.length === 0) {
            this.contentEl.createEl('p', {
                text: 'No speaker notes found. Open a Marp file with HTML comments.',
                cls: 'marp-tikz-placeholder'
            });
            return;
        }

        const header = this.contentEl.createDiv({ cls: 'notes-header' });
        header.createSpan({ text: `Slide ${this._currentSlide + 1} of ${this._notes.length}` });

        const nav = header.createDiv({ cls: 'notes-nav' });
        const prevBtn = nav.createEl('button', { text: '←' });
        const nextBtn = nav.createEl('button', { text: '→' });
        prevBtn.disabled = this._currentSlide <= 0;
        nextBtn.disabled = this._currentSlide >= this._notes.length - 1;
        prevBtn.addEventListener('click', () => { this.setCurrentSlide(this._currentSlide - 1); });
        nextBtn.addEventListener('click', () => { this.setCurrentSlide(this._currentSlide + 1); });

        const note = this._notes[this._currentSlide] || '';
        const notesBody = this.contentEl.createDiv({ cls: 'notes-body marp-notes-content' });
        if (note) {
            // Same renderer as the in-preview notes panel, so both agree on
            // headings, lists, tables and emphasis. Content is escaped there.
            notesBody.innerHTML = renderNotesMarkdown(note);
        } else {
            notesBody.createEl('p', { text: '(no notes for this slide)', cls: 'marp-tikz-placeholder' });
        }

        // Quick-jump: show all slides with notes
        const allNotes = this.contentEl.createDiv({ cls: 'notes-all' });
        allNotes.createEl('h4', { text: 'All slides' });
        this._notes.forEach((n, i) => {
            const row = allNotes.createDiv({ cls: 'notes-row' + (i === this._currentSlide ? ' active' : '') });
            row.createSpan({ cls: 'notes-row-num', text: String(i + 1) });
            row.createSpan({ cls: 'notes-row-preview', text: n ? n.slice(0, 80) : '—' });
            row.addEventListener('click', () => this.setCurrentSlide(i));
        });
    }

    async onClose(): Promise<void> { /* nothing */ }
}
