import * as path from 'path';
import { TikzBlock } from './TikzBlock';
import { IncludeResolver } from './IncludeResolver';

export class DocumentParser {
    private static readonly TIKZ_BLOCK_REGEX = /^```tikz\s*$([\s\S]*?)^```\s*$/mig;

    readonly includeResolver = new IncludeResolver();
    private readonly _includedFiles = new Map<string, Set<string>>();

    parse(text: string, filePath: string): TikzBlock[] {
        const blocks: TikzBlock[] = [];
        const baseDir = filePath ? path.dirname(filePath) : process.cwd();
        const docKey = filePath;
        const includedFiles = new Set<string>();

        DocumentParser.TIKZ_BLOCK_REGEX.lastIndex = 0;

        let match: RegExpExecArray | null;
        while ((match = DocumentParser.TIKZ_BLOCK_REGEX.exec(text)) !== null) {
            const fullMatch = match[0];
            let codeContent = match[1];
            const startOffset = match.index;

            const includeResult = this.includeResolver.resolve(codeContent, baseDir);
            if (includeResult) {
                if (includeResult.ok) {
                    codeContent = includeResult.value.content;
                    includedFiles.add(includeResult.value.filePath);
                } else {
                    continue;
                }
            }

            const lineNumber = text.substring(0, startOffset + fullMatch.indexOf('\n') + 1)
                .split('\n').length - 1;

            blocks.push(new TikzBlock(codeContent, lineNumber));
        }

        this._includedFiles.set(docKey, includedFiles);
        return blocks;
    }

    getIncludedFiles(filePath: string): Set<string> {
        return this._includedFiles.get(filePath) ?? new Set();
    }
}
