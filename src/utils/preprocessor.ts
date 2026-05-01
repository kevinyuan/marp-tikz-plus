export function preprocessSource(source: string): string {
    // Remove non-breaking spaces (U+00A0)
    let processed = source.replace(/ /g, ' ');

    const lines = processed.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    processed = lines.join('\n');

    if (!processed) { return processed; }

    if (!processed.includes('\\begin{document}')) {
        processed = '\\begin{document}\n' + processed + '\n\\end{document}';
    }

    return processed;
}
