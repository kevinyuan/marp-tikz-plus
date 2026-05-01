const CJK_INJECT_MARKER = 'tikz-marp-cjk-inject';

const CJK_STYLE_BLOCK =
    `<style data-${CJK_INJECT_MARKER}>\n` +
    `@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');\n` +
    `section, h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, code, pre, figcaption, caption, small, strong, em {\n` +
    `  font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Helvetica, Arial, 'Noto Sans SC', sans-serif;\n` +
    `}\n` +
    `</style>\n`;

export function injectMarpCjkFont(md: string): string {
    if (md.includes(`data-${CJK_INJECT_MARKER}`)) { return md; }
    const fmMatch = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (!fmMatch) { return md; }
    const fmEnd = fmMatch[0];
    const rest = md.slice(fmEnd.length);
    return `${fmEnd}\n${CJK_STYLE_BLOCK}\n${rest}`;
}
