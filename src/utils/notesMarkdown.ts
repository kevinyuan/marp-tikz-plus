/**
 * Minimal Markdown → HTML renderer for speaker notes.
 *
 * Shared by the in-preview notes panel (MarpView) and the standalone notes
 * view, so both render notes identically. Supports headings (all six levels),
 * bold, italic, inline code, fenced code, lists, tables, links and rules.
 *
 * All text is HTML-escaped before any markup is added, so note content can
 * never inject markup into the panel.
 */

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function renderNotesMarkdown(src: string): string {
    if (!src) { return ''; }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s: string) => s
        .replace(/`([^`]+)`/g, (_, c) => '<code>' + esc(c) + '</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    const lines = src.split('\n');
    const out: string[] = [];
    let i = 0;
    const flushPara = (buf: string[]) => {
        if (buf.length) { out.push('<p>' + inline(esc(buf.join(' '))) + '</p>'); }
        return [] as string[];
    };
    let para: string[] = [];

    while (i < lines.length) {
        const line = lines[i];
        if (/^```/.test(line)) {
            para = flushPara(para);
            const lang = line.slice(3).trim();
            const codeLines: string[] = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(esc(lines[i])); i++; }
            out.push('<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + codeLines.join('\n') + '</code></pre>');
            i++; continue;
        }
        // All six heading levels. Notes commonly use #### for sub-sections, and
        // capping this at three levels rendered those as literal '#### ...' text.
        const hm = line.match(/^(#{1,6})\s+(.*)/);
        if (hm) {
            para = flushPara(para);
            const level = hm[1].length;
            out.push('<h' + level + '>' + inline(esc(hm[2])) + '</h' + level + '>');
            i++; continue;
        }
        if (/^(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
            para = flushPara(para);
            out.push('<hr>');
            i++; continue;
        }
        if (/^[-*+]\s/.test(line)) {
            para = flushPara(para);
            const ulItems: string[] = [];
            while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
                ulItems.push('<li>' + inline(esc(lines[i].replace(/^[-*+]\s/, ''))) + '</li>');
                i++;
            }
            out.push('<ul>' + ulItems.join('') + '</ul>');
            continue;
        }
        if (/^\d+\.\s/.test(line)) {
            para = flushPara(para);
            const olItems: string[] = [];
            while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
                olItems.push('<li>' + inline(esc(lines[i].replace(/^\d+\.\s/, ''))) + '</li>');
                i++;
            }
            out.push('<ol>' + olItems.join('') + '</ol>');
            continue;
        }
        if (/^\|/.test(line)) {
            para = flushPara(para);
            const tRows: string[] = [];
            while (i < lines.length && /^\|/.test(lines[i])) { tRows.push(lines[i]); i++; }
            const parseRow = (r: string, tag: string) =>
                '<tr>' + r.replace(/^\||\|$/g, '').split('|').map(c =>
                    '<' + tag + '>' + inline(esc(c.trim())) + '</' + tag + '>'
                ).join('') + '</tr>';
            let tableHtml = '<table><thead>' + parseRow(tRows[0], 'th') + '</thead>';
            const bodyRows = tRows.slice(2);
            if (bodyRows.length) {
                tableHtml += '<tbody>' + bodyRows.map(r => parseRow(r, 'td')).join('') + '</tbody>';
            }
            out.push(tableHtml + '</table>');
            continue;
        }
        if (/^\s*$/.test(line)) { para = flushPara(para); i++; continue; }
        para.push(line);
        i++;
    }
    flushPara(para);
    return out.join('\n');
}
