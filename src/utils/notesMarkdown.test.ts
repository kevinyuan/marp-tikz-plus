import { renderNotesMarkdown, escapeHtml } from './notesMarkdown';

describe('renderNotesMarkdown', () => {
    it('renders every heading level, including h4 to h6', () => {
        expect(renderNotesMarkdown('# One')).toBe('<h1>One</h1>');
        expect(renderNotesMarkdown('### Three')).toBe('<h3>Three</h3>');
        expect(renderNotesMarkdown('#### Four')).toBe('<h4>Four</h4>');
        expect(renderNotesMarkdown('##### Five')).toBe('<h5>Five</h5>');
        expect(renderNotesMarkdown('###### Six')).toBe('<h6>Six</h6>');
    });

    it('does not treat seven hashes as a heading', () => {
        expect(renderNotesMarkdown('####### Seven')).toBe('<p>####### Seven</p>');
    });

    it('renders a real speaker-notes block', () => {
        const src = [
            '#### 讲稿要点',
            '- 第一点',
            '- 第二点',
            '',
            '#### 图注',
            'Plain paragraph with **bold** and `code`.',
        ].join('\n');
        expect(renderNotesMarkdown(src)).toBe([
            '<h4>讲稿要点</h4>',
            '<ul><li>第一点</li><li>第二点</li></ul>',
            '<h4>图注</h4>',
            '<p>Plain paragraph with <strong>bold</strong> and <code>code</code>.</p>',
        ].join('\n'));
    });

    it('renders inline emphasis, links and code', () => {
        expect(renderNotesMarkdown('*it* and [x](http://y)'))
            .toBe('<p><em>it</em> and <a href="http://y">x</a></p>');
    });

    it('renders lists, tables, rules and fenced code', () => {
        expect(renderNotesMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
        expect(renderNotesMarkdown('---')).toBe('<hr>');
        expect(renderNotesMarkdown('```js\nlet a = 1;\n```'))
            .toBe('<pre><code class="language-js">let a = 1;</code></pre>');
        expect(renderNotesMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'))
            .toBe('<table><thead><tr><th>a</th><th>b</th></tr></thead>'
                + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
    });

    it('escapes HTML in note text', () => {
        expect(renderNotesMarkdown('#### <script>alert(1)</script>'))
            .toBe('<h4>&lt;script&gt;alert(1)&lt;/script&gt;</h4>');
    });

    it('returns an empty string for empty input', () => {
        expect(renderNotesMarkdown('')).toBe('');
    });
});

describe('escapeHtml', () => {
    it('escapes the four markup characters', () => {
        expect(escapeHtml('<a href="x">&</a>'))
            .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    });
});
