import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { extractAndReplaceMath, ExtractedMath } from '../utils/mathPreprocessor';
import { latexToOmml } from '../utils/mathToOmml';
import { injectMarpCjkFont } from '../utils/marpCjkFont';
import { DocumentParser } from '../core/DocumentParser';

export { parseSpeakerNotes };

export class PptxExporter {
    constructor(
        private readonly parser: DocumentParser,
        private readonly renderTikzToSvg: (source: string) => Promise<string>,
        private readonly log: (msg: string) => void,
    ) {}

    async export(filePath: string, content: string, opts: {
        format: 'pptx' | 'pdf';
        includeNotes: boolean;
        onProgress?: (msg: string) => void;
        signal?: AbortSignal;
    }): Promise<string> {
        const inputDir = path.dirname(filePath);
        const inputBasename = path.basename(filePath, '.md');

        let md = content;
        const baseDir = inputDir;

        // Parse tikz blocks, resolving %!include directives
        const tikzRegex = /^```tikz\s*$([\s\S]*?)^```\s*$/gm;
        const blocks: { full: string; source: string; includeError?: string }[] = [];
        let match;
        while ((match = tikzRegex.exec(md)) !== null) {
            const rawSource = match[1];
            let resolvedSource = rawSource;
            let includeError: string | undefined;
            const includeResult = this.parser.includeResolver.resolve(rawSource, baseDir);
            if (includeResult) {
                if (includeResult.ok) {
                    resolvedSource = includeResult.value.content;
                } else {
                    includeError = includeResult.error.message;
                }
            }
            blocks.push({ full: match[0], source: resolvedSource, includeError });
        }

        // Create temp directory for processed files
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tikz-marp-'));
        const imgDir = path.join(tmpDir, '.tikz-images');
        fs.mkdirSync(imgDir);

        try {
            // Render TikZ blocks to SVG
            if (blocks.length > 0) {
                for (let i = 0; i < blocks.length; i++) {
                    if (opts.signal?.aborted) { throw new Error('Export cancelled'); }
                    opts.onProgress?.(`Rendering diagram ${i + 1}/${blocks.length}…`);

                    if (blocks[i].includeError) {
                        this.log(`[marp-export] Include failed for block ${i + 1}: ${blocks[i].includeError}`);
                        md = md.replace(blocks[i].full, `<p style="color:red;">TikZ include failed: ${escapeHtml(blocks[i].includeError!)}</p>`);
                        continue;
                    }

                    try {
                        const svg = await this.renderTikzToSvg(blocks[i].source);
                        const fixed = fixSvgDimensions(svg);
                        const svgFile = path.join(imgDir, `tikz-${i + 1}.svg`);
                        fs.writeFileSync(svgFile, fixed, 'utf-8');

                        const relPath = `.tikz-images/tikz-${i + 1}.svg`;
                        const imgTag = `\n<div style="display:flex;justify-content:center;align-items:center;"><img src="${relPath}" /></div>\n`;
                        md = md.replace(blocks[i].full, imgTag);
                    } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : String(err);
                        md = md.replace(blocks[i].full, `<p style="color:red;">TikZ render failed: ${escapeHtml(msg)}</p>`);
                    }
                }
            }

            if (opts.signal?.aborted) { throw new Error('Export cancelled'); }

            const useEditable = true;
            const isPptxEditable = opts.format === 'pptx' && useEditable && marpSupportsEditablePptx();

            const mathResult = isPptxEditable
                ? extractAndReplaceMath(md)
                : { processedMarkdown: md, formulas: [] as ExtractedMath[] };
            md = mathResult.processedMarkdown;
            if (mathResult.formulas.length > 0) {
                this.log(`[marp-export] Extracted ${mathResult.formulas.length} math formula(s) for OMML injection`);
            }
            // Strip .eq-row / .eq-body div wrappers so display math placeholders are inline
            // in the paragraph flow. Without stripping, LibreOffice creates a separate floating
            // shape per formula, causing OMML to appear as a layer overlapping adjacent content.
            if (isPptxEditable && mathResult.formulas.some(f => f.isDisplay)) {
                md = md.replace(
                    /<div class="eq-row">\s*<div class="eq-body">\s*(MARPMATH\d+)\s*<\/div>(?:\s*<div class="eq-num">([^<]*)<\/div>)?\s*<\/div>/g,
                    (_m: string, placeholder: string, eqNum?: string) =>
                        `\n\n${placeholder}${eqNum ? '    ' + eqNum.trim() : ''}\n\n`
                );
                // Collapse 3+ consecutive newlines to 2 to prevent extra blank paragraphs in PPTX
                md = md.replace(/\n{3,}/g, '\n\n');
            }

            // Inject CJK font stack so Chinese / Japanese / Korean glyphs render
            // in both PDF (Chromium) and PPTX (LibreOffice) exports.
            md = injectMarpCjkFont(md);

            // Write processed markdown to temp dir
            const processedMdPath = path.join(tmpDir, `${inputBasename}.md`);
            fs.writeFileSync(processedMdPath, md, 'utf-8');

            // Symlink assets from original directory so relative paths in CSS resolve
            for (const entry of fs.readdirSync(inputDir)) {
                const src = path.join(inputDir, entry);
                const dest = path.join(tmpDir, entry);
                if (!fs.existsSync(dest)) {
                    try { fs.symlinkSync(src, dest); } catch { /* skip if symlink fails */ }
                }
            }

            // Determine output path (next to original file, timestamped)
            const now = new Date();
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            const outputExt = opts.format === 'pdf' ? '.pdf' : '.pptx';
            const outputPath = path.join(inputDir, `${inputBasename}-${dd}-${hh}${mm}${ss}${outputExt}`);

            // Run marp-cli with retry on failure
            const maxAttempts = 2;
            let lastError: Error | undefined;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (opts.signal?.aborted) { throw new Error('Export cancelled'); }
                opts.onProgress?.(
                    attempt > 1
                        ? `Retrying marp-cli (attempt ${attempt}/${maxAttempts})…`
                        : 'Running marp-cli…'
                );
                try {
                    await runMarpCli(processedMdPath, outputPath, tmpDir, MARP_CLI_TIMEOUT, useEditable, opts.format, this.log);
                    lastError = undefined;
                    break;
                } catch (err: unknown) {
                    lastError = err instanceof Error ? err : new Error(String(err));
                    this.log(`[marp-export] Attempt ${attempt} failed: ${lastError.message}`);
                }
            }

            if (lastError) {
                throw lastError;
            }

            // PPTX-only post-processing
            if (opts.format === 'pptx') {
                // Remove full-slide blank overlay shapes (LibreOffice artefact)
                try {
                    await fixPptxOverlays(outputPath);
                    this.log('[marp-export] Post-processed PPTX: removed overlay shapes');
                } catch (ppErr: unknown) {
                    const msg = ppErr instanceof Error ? ppErr.message : String(ppErr);
                    this.log(`[marp-export] PPTX post-processing failed: ${msg}`);
                }

                // Inject native OMML math objects
                if (mathResult.formulas.length > 0) {
                    opts.onProgress?.('Injecting math formulas…');
                    try {
                        await injectMathIntoSlides(outputPath, mathResult.formulas);
                        this.log(`[marp-export] Injected ${mathResult.formulas.length} math formula(s) as OMML`);
                    } catch (mErr: unknown) {
                        const msg = mErr instanceof Error ? mErr.message : String(mErr);
                        this.log(`[marp-export] Math injection failed: ${msg}`);
                    }
                }

                // Inject speaker notes
                if (opts.includeNotes) {
                    const slideNotes = parseSpeakerNotes(content);
                    if (slideNotes.some(n => n)) {
                        opts.onProgress?.('Injecting speaker notes…');
                        try {
                            await injectSpeakerNotes(outputPath, slideNotes);
                            this.log(`[marp-export] Injected speaker notes for ${slideNotes.filter(n => n).length} slide(s)`);
                        } catch (nErr: unknown) {
                            const msg = nErr instanceof Error ? nErr.message : String(nErr);
                            this.log(`[marp-export] Speaker notes injection failed: ${msg}`);
                        }
                    }
                }
            }

            return outputPath;
        } finally {
            // Cleanup temp directory
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}

// ─── Speaker Notes ────────────────────────────────────────────────────────────

/** Parse Marp speaker notes from markdown source.
 *  Notes are HTML comments (<!-- ... -->) within each slide. */
function parseSpeakerNotes(markdown: string): string[] {
    const lines = markdown.split('\n');
    const notes: string[] = [];
    let currentNotes: string[] = [];
    let inFrontmatter = false;
    let frontmatterDone = false;
    let inComment = false;
    let commentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip frontmatter
        if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue; }
        if (inFrontmatter && line.trim() === '---') { inFrontmatter = false; frontmatterDone = true; continue; }
        if (inFrontmatter || !frontmatterDone) { continue; }

        // Slide separator
        if (line.trim() === '---') {
            notes.push(currentNotes.join('\n').trim());
            currentNotes = [];
            continue;
        }

        // Multi-line comment handling
        if (inComment) {
            const endIdx = line.indexOf('-->');
            if (endIdx >= 0) {
                commentLines.push(line.substring(0, endIdx));
                currentNotes.push(commentLines.join('\n').trim());
                commentLines = [];
                inComment = false;
            } else {
                commentLines.push(line);
            }
            continue;
        }

        // Single-line comment: <!-- ... -->
        const singleMatch = line.match(/<!--\s*(.*?)\s*-->/);
        if (singleMatch) {
            // Skip directives like <!-- _class: title -->
            const commentContent = singleMatch[1];
            if (commentContent && !commentContent.match(/^_?\w+\s*:/)) {
                currentNotes.push(commentContent);
            }
            continue;
        }

        // Start of multi-line comment: <!--
        const startMatch = line.match(/<!--\s*(.*)/);
        if (startMatch) {
            inComment = true;
            commentLines = [startMatch[1]];
            continue;
        }
    }
    // Last slide
    notes.push(currentNotes.join('\n').trim());

    return notes;
}

// ─── SVG / HTML helpers ───────────────────────────────────────────────────────

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Fix SVG width/height to match viewBox (same as marp-tikz.js fixSvgDimensions).
 */
function fixSvgDimensions(svg: string): string {
    const viewBoxMatch = svg.match(/viewBox="([^"]+)"/);
    if (!viewBoxMatch) { return svg; }
    const parts = viewBoxMatch[1].trim().split(/\s+/);
    if (parts.length !== 4) { return svg; }
    let result = svg.replace(/(<svg[^>]*?\s)width="[^"]*"/, `$1width="${parts[2]}pt"`);
    result = result.replace(/(<svg[^>]*?\s)height="[^"]*"/, `$1height="${parts[3]}pt"`);
    return result;
}

// ─── marp-cli ─────────────────────────────────────────────────────────────────

/** Resolve marp-cli command and args prefix. */
function resolveMarpCli(): { cmd: string; prefix: string[] } {
    try {
        const resolved = require.resolve('@marp-team/marp-cli/marp-cli.js');
        return { cmd: process.execPath, prefix: [resolved] };
    } catch {
        return { cmd: 'npx', prefix: ['@marp-team/marp-cli'] };
    }
}

// Cached on first call — spawning marp-cli/soffice for version checks is slow (~2-3s)
let _marpEditableCache: boolean | undefined;
let _libreOfficeCache: boolean | undefined;

/** Check marp-cli version and return true if >= 4.1.0. Result is cached. */
function marpSupportsEditablePptx(): boolean {
    if (_marpEditableCache !== undefined) { return _marpEditableCache; }
    try {
        const { cmd, prefix } = resolveMarpCli();
        const verOut = execFileSync(cmd, [...prefix, '--version'], {
            encoding: 'utf-8', timeout: 10000,
        }).trim();
        const m = verOut.match(/(\d+)\.(\d+)\.\d+/);
        if (!m) { _marpEditableCache = false; return false; }
        const [, major, minor] = m.map(Number);
        _marpEditableCache = major > 4 || (major === 4 && minor >= 1);
    } catch {
        _marpEditableCache = false;
    }
    return _marpEditableCache;
}

function isLibreOfficeInstalled(): boolean {
    if (_libreOfficeCache !== undefined) { return _libreOfficeCache; }
    try {
        if (process.platform === 'darwin') {
            _libreOfficeCache = fs.existsSync('/Applications/LibreOffice.app');
        } else if (process.platform === 'win32') {
            execFileSync('where', ['soffice'], { encoding: 'utf-8', timeout: 5000 });
            _libreOfficeCache = true;
        } else {
            execFileSync('which', ['soffice'], { encoding: 'utf-8', timeout: 5000 });
            _libreOfficeCache = true;
        }
    } catch {
        _libreOfficeCache = false;
    }
    return _libreOfficeCache;
}

/** Timeout value for marp-cli (60 seconds) */
const MARP_CLI_TIMEOUT = 60_000;

/**
 * Run marp-cli to convert processed markdown to PPTX or PDF.
 */
function runMarpCli(
    processedMdPath: string,
    outputPath: string,
    cwd: string,
    timeoutMs: number,
    useEditable: boolean,
    format: 'pptx' | 'pdf' = 'pptx',
    log: (msg: string) => void,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const { cmd, prefix } = resolveMarpCli();

        const formatFlag = format === 'pdf' ? '--pdf' : '--pptx';
        const args = [formatFlag, '--allow-local-files', '--html', '--no-stdin', processedMdPath, '-o', outputPath];
        if (format === 'pptx' && useEditable && marpSupportsEditablePptx()) {
            args.splice(1, 0, '--pptx-editable');
            log('[marp-export] --pptx-editable enabled (editable slides; disable if math misaligns)');
        } else if (format === 'pptx' && !useEditable) {
            log('[marp-export] --pptx-editable disabled; using bitmap PPTX for accurate math rendering');
        }
        const cmdArgs = [...prefix, ...args];

        const child = execFile(cmd, cmdArgs, {
            cwd,
            timeout: timeoutMs,
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
        }, (error, _stdout, stderr) => {
            if (error) {
                const msg = stderr?.trim() || error.message;
                if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
                    reject(new Error(`marp-cli timed out after ${timeoutMs / 1000}s`));
                } else {
                    reject(new Error(msg));
                }
            } else {
                resolve();
            }
        });

        // Safety: kill the process if it's still running when timeout fires
        const timer = window.setTimeout(() => {
            child.kill('SIGKILL');
        }, timeoutMs + 5000);
        child.on('exit', () => window.clearTimeout(timer));
    });
}

// ─── PPTX overlay fix ────────────────────────────────────────────────────────

/**
 * Remove full-slide blank overlay shapes from editable PPTX and renumber IDs.
 * LibreOffice's ODP→PPTX conversion generates opaque white rectangles
 * that cover the entire slide, blocking interaction with real content.
 * After removal, shape IDs are renumbered to avoid gaps that trigger
 * PowerPoint's repair prompt.
 */
async function fixPptxOverlays(pptxPath: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    let modified = false;

    // Read slide dimensions from presentation.xml
    const presXml = await zip.file('ppt/presentation.xml')!.async('string');
    const sldSzMatch = presXml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (!sldSzMatch) { return; }
    const slideW = parseInt(sldSzMatch[1], 10);
    const slideH = parseInt(sldSzMatch[2], 10);

    const slidePattern = /^ppt\/slides\/slide\d+\.xml$/;
    for (const filename of Object.keys(zip.files)) {
        if (!slidePattern.test(filename)) { continue; }

        const original = await zip.file(filename)!.async('string');
        let xml = original;

        xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (match: string) => {
            const extMatch = match.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
            if (!extMatch) { return match; }
            const cx = parseInt(extMatch[1], 10);
            const cy = parseInt(extMatch[2], 10);
            // Shape must cover >= 98% of the slide to be considered an overlay
            if (cx < slideW * 0.98 || cy < slideH * 0.98) { return match; }
            // Only remove white (FFFFFF) overlays; keep colored backgrounds
            const fillMatch = match.match(/<a:solidFill>\s*<a:srgbClr\s+val="([^"]+)"/);
            if (fillMatch && fillMatch[1] !== 'FFFFFF') { return match; }
            const textRegex = /<a:t>([^<]*)<\/a:t>/g;
            let tm;
            while ((tm = textRegex.exec(match)) !== null) {
                if (tm[1].trim()) { return match; }
            }
            return '';
        });

        if (xml !== original) {
            let nextId = 2;
            xml = xml.replace(/<p:cNvPr\s+id="(\d+)"/g, (matchStr: string, id: string) => {
                if (id === '1') { return matchStr; }
                return `<p:cNvPr id="${nextId++}"`;
            });
            zip.file(filename, xml);
            modified = true;
        }
    }

    if (modified) {
        const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        fs.writeFileSync(pptxPath, output);
    }
}

// ─── OMML Math Injection ─────────────────────────────────────────────────────

const OMML_M_NS   = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const OMML_A14_NS = 'http://schemas.microsoft.com/office/drawing/2010/main';

/**
 * Post-processes a PPTX file: finds placeholder text injected by extractAndReplaceMath(),
 * converts each formula to OMML, and replaces the placeholder with a native PowerPoint
 * math object (<m:oMath>...</m:oMath> directly inside <a:p>).
 */
async function injectMathIntoSlides(pptxPath: string, formulas: ExtractedMath[]): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
    const formulaMap = new Map<string, ExtractedMath>(formulas.map(f => [f.placeholder, f]));
    const slidePattern = /^ppt\/slides\/slide\d+\.xml$/;
    let modified = false;

    // Read slide dimensions from presentation.xml
    let slideCx = 12192000; // default: 1280px Marp widescreen
    let slideCy = 6858000;  // default: 720px Marp widescreen
    const presFile = zip.file('ppt/presentation.xml');
    if (presFile) {
        const presXml: string = await presFile.async('string');
        const cxM = /sldSz\b[^>]*\bcx="(\d+)"/.exec(presXml);
        const cyM = /sldSz\b[^>]*\bcy="(\d+)"/.exec(presXml);
        if (cxM) { slideCx = parseInt(cxM[1], 10); }
        if (cyM) { slideCy = parseInt(cyM[1], 10); }
    }

    for (const filename of Object.keys(zip.files)) {
        if (!slidePattern.test(filename)) { continue; }
        const original: string = await zip.file(filename)!.async('string');
        const processed = processSlideXml(original, formulaMap, slideCx, slideCy);
        if (processed !== original) {
            zip.file(filename, processed);
            modified = true;
        }
    }

    if (modified) {
        const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
        fs.writeFileSync(pptxPath, output);
    }
}

/** Inject m: and a14: namespaces into the slide root element if not already present. */
function ensureSlideNamespaces(xml: string): string {
    let out = xml;
    if (!out.includes('xmlns:m=')) {
        out = out.replace(/(<p:sld\b[^>]*?)(\s*>)/, `$1 xmlns:m="${OMML_M_NS}"$2`);
    }
    if (!out.includes('xmlns:a14=')) {
        out = out.replace(/(<p:sld\b[^>]*?)(\s*>)/, `$1 xmlns:a14="${OMML_A14_NS}"$2`);
    }
    return out;
}

/**
 * Processes a single slide XML string, replacing all math placeholders with OMML.
 * Operates at the <p:sp> shape level so we can also fix shape geometry for display math.
 */
function processSlideXml(xml: string, formulaMap: Map<string, ExtractedMath>, slideCx: number, slideCy: number): string {
    let hasAny = false;
    for (const key of formulaMap.keys()) {
        if (xml.includes(key)) { hasAny = true; break; }
    }
    if (!hasAny) { return xml; }

    let result = xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/g, (spXml: string) => {
        return processShape(spXml, formulaMap, slideCx);
    });

    if (result === xml) { return xml; }

    // Second pass: detect and resolve vertical overlap for display math shapes.
    // Must run before centering so we know the true post-expansion content height.
    result = fixDisplayMathLayout(result, slideCx, slideCy);

    // Third pass: vertically center the content cluster in the available zone.
    // Because content height varies per slide (more formulas → taller cluster),
    // margins are computed automatically rather than hardcoded.
    result = centerContentVertically(result, slideCy);

    return ensureSlideNamespaces(result);
}

/**
 * Processes a single <p:sp> shape: injects OMML for any math placeholders,
 * and widens the shape to slide width when it contains only display math.
 */
function processShape(spXml: string, formulaMap: Map<string, ExtractedMath>, slideCx: number): string {
    let hasAny = false;
    for (const key of formulaMap.keys()) {
        if (spXml.includes(key)) { hasAny = true; break; }
    }
    if (!hasAny) { return spXml; }

    // Detect display-only shape BEFORE injecting (placeholder text is still present)
    const displayOnly = isDisplayMathOnlyShape(spXml, formulaMap);

    // Inject OMML into paragraphs
    let result = spXml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (paraXml: string, paraContent: string) => {
        return processParagraph(paraXml, paraContent, formulaMap, displayOnly);
    });

    if (result === spXml) { return spXml; }

    // Remove empty paragraphs adjacent to OMML — artifacts of \n\n placeholder wrapping
    if (result.includes('a14:m')) {
        result = removeEmptyParasAdjacentToOmml(result);
    }

    // For display-only shapes: widen to slide width so centering works correctly
    if (displayOnly) { result = widenShape(result, slideCx); }

    return result;
}

/** Returns true if the shape's entire text content is exactly one display math placeholder. */
function isDisplayMathOnlyShape(spXml: string, formulaMap: Map<string, ExtractedMath>): boolean {
    const tRe = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let m: RegExpExecArray | null;
    let combined = '';
    while ((m = tRe.exec(spXml)) !== null) {
        combined += decodeXmlEntities(m[1]);
    }
    const formula = formulaMap.get(combined.trim());
    return formula?.isDisplay === true;
}

/** Widens a shape to slide width (x=0) for display math centering.
 *  Only adjusts horizontal geometry; cy (height) is left exactly as LibreOffice set it
 *  so we never artificially resize formula shapes. */
function widenShape(spXml: string, slideCx: number): string {
    let result = spXml;
    result = result.replace(/(<a:off\b[^>]*\bx=")[^"]*"/, '$10"');
    result = result.replace(/(<a:ext\b[^>]*\bcx=")[^"]*"/, `$1${slideCx}"`);
    return result;
}

// ─── Display-math layout adjustment ──────────────────────────────────────────

/**
 * Removes empty <a:p> paragraphs immediately before or after OMML-containing paragraphs
 * within a single shape's XML. These empty paragraphs are artifacts of the \n\n wrapping
 * added around math placeholders in extractAndReplaceMath().
 */
function removeEmptyParasAdjacentToOmml(spXml: string): string {
    let result = spXml;
    // Remove empty paragraph (no <a:r> or <a14:m>) immediately BEFORE an OMML paragraph
    result = result.replace(
        /<a:p>([\s\S]*?)<\/a:p>(\s*<a:p>[\s\S]*?<a14:m>)/g,
        (_m, before, next) => /<a:r>|<a14:m>/.test(before) ? `<a:p>${before}</a:p>${next}` : next
    );
    // Remove empty paragraph immediately AFTER an OMML paragraph
    result = result.replace(
        /(<\/a14:m>[\s\S]*?<\/a:p>)\s*<a:p>([\s\S]*?)<\/a:p>/g,
        (_m, ommlClose, after) =>
            /<a:r>|<a14:m>/.test(after) ? `${ommlClose}<a:p>${after}</a:p>` : ommlClose
    );
    return result;
}

/**
 * Vertically centers the content cluster in the zone between the slide header and
 * footer. Margins are computed automatically from actual content height, so slides
 * with more content get smaller margins and slides with less content get larger ones.
 *
 * Runs AFTER fixDisplayMathLayout so formula shapes already have their expanded cy,
 * giving an accurate content span to center against.
 *
 * Footer detection: Marp footer shapes are thin decorative bars (cy < 200 000 EMU)
 * located in the bottom 10 % of the slide — distinguished from content shapes that
 * fixDisplayMathLayout may have pushed into the same region.
 *
 * Only shifts content UP (removes the LibreOffice-added blank gap). Never shifts
 * down — if content is already at or below center the slide layout is left alone.
 */
function centerContentVertically(xml: string, slideCy: number): string {
    const HEADER_ZONE    = Math.round(slideCy * 0.15);  // y < this → header shape
    const FOOTER_Y_MIN   = Math.round(slideCy * 0.90);  // y > this AND small cy → footer
    const FOOTER_CY_MAX  = 200000;                       // thin bar ≈ footer decoration

    // Scan <p:sp> shapes to classify each as header, footer, or content.
    const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
    let spM: RegExpExecArray | null;
    let headerBottom   = 0;
    let firstContentY  = Infinity;
    let lastContentBot = 0;

    while ((spM = spRe.exec(xml)) !== null) {
        const inner = spM[1];
        const yM  = /<a:off\b[^>]*\by="(\d+)"/.exec(inner);
        const cyM = /<a:ext\b[^>]*\bcy="(\d+)"/.exec(inner);
        if (!yM || !cyM) { continue; }
        const y  = parseInt(yM[1], 10);
        const cy = parseInt(cyM[1], 10);

        if (y < HEADER_ZONE) {
            headerBottom = Math.max(headerBottom, y + cy);
        } else if (y >= FOOTER_Y_MIN && cy < FOOTER_CY_MAX) {
            // Thin bar near slide bottom — Marp footer decoration, skip
        } else {
            firstContentY  = Math.min(firstContentY, y);
            lastContentBot = Math.max(lastContentBot, y + cy);
        }
    }

    if (firstContentY === Infinity || headerBottom === 0) { return xml; }

    const contentSpan   = lastContentBot - firstContentY;
    const footerTop     = Math.round(slideCy * 0.93); // conservative footer boundary
    const availableZone = footerTop - headerBottom;

    if (contentSpan >= availableZone) { return xml; }  // content already fills zone

    // Target: equal margins above and below the content cluster
    const margin      = Math.round((availableZone - contentSpan) / 2);
    const targetFirst = headerBottom + margin;
    const upShift     = firstContentY - targetFirst;

    if (upShift <= 0) { return xml; }   // already at or below center — leave it
    if (upShift < 100000) { return xml; } // negligible shift

    // Apply shift only to content shapes (skip header and footer shapes by y+cy criteria)
    return xml.replace(/<p:sp>([\s\S]*?)<\/p:sp>/g, (spXml: string, inner: string) => {
        const yM  = /<a:off\b[^>]*\by="(\d+)"/.exec(inner);
        const cyM = /<a:ext\b[^>]*\bcy="(\d+)"/.exec(inner);
        if (!yM || !cyM) { return spXml; }
        const y  = parseInt(yM[1], 10);
        const cy = parseInt(cyM[1], 10);
        if (y < HEADER_ZONE) { return spXml; }                          // header
        if (y >= FOOTER_Y_MIN && cy < FOOTER_CY_MAX) { return spXml; } // footer
        return spXml.replace(/(<a:off\b[^>]*\by=")(\d+)("[^>]*\/>)/g,
            (_m, pre, yStr, post) => `${pre}${parseInt(yStr, 10) - upShift}${post}`
        );
    });
}

/**
 * After OMML injection, detects display-math shapes (full slide width) that may
 * overflow into content below, and shifts those lower shapes down to avoid overlap.
 * Estimates formula height from font size and OMML structural complexity.
 */
function fixDisplayMathLayout(xml: string, slideCx: number, slideCy: number): string {
    // Detect body font size once — used to normalize display math sz to match Marp rendering.
    // LibreOffice sets sz=2000 (20pt) on display math shapes but Marp renders at body sz (~16.5pt),
    // causing formulas to appear 1.2x too large in PPTX. Normalizing fixes both size and bounding box.
    const bodySz = findBodyFontSize(xml);

    type ShapeInfo = { y: number; estimatedCy: number };
    const mathShapes: ShapeInfo[] = [];
    const shapeReplacements: Array<{ original: string; replacement: string }> = [];

    const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
    let spM: RegExpExecArray | null;
    while ((spM = spRe.exec(xml)) !== null) {
        const spXml = spM[0];
        const inner = spM[1];
        if (!inner.includes('a14:m')) { continue; }

        const yM  = /<a:off\b[^>]*\by="(\d+)"/.exec(inner);
        const cxM = /<a:ext\b[^>]*\bcx="(\d+)"/.exec(inner);
        if (!yM || !cxM) { continue; }

        // Skip inline math shapes (not full-width) — only display math has cx === slideCx
        if (parseInt(cxM[1], 10) !== slideCx) { continue; }

        const ommlM = /<m:oMath>[\s\S]*?<\/m:oMath>/.exec(inner);
        const estimatedCy = estimateOmmlHeightEmu(ommlM ? ommlM[0] : '', bodySz);

        mathShapes.push({ y: parseInt(yM[1], 10), estimatedCy });

        // Normalize sz to body size and set cy to estimated height so the bounding box
        // matches the visual formula size (fixes "selection box too small" issue).
        let modified = normalizeShapeSz(spXml, bodySz);
        modified = setShapeCy(modified, estimatedCy);
        shapeReplacements.push({ original: spXml, replacement: modified });
    }
    if (mathShapes.length === 0) { return xml; }

    // Apply shape modifications (sz normalization + cy correction)
    let result = xml;
    for (const { original, replacement } of shapeReplacements) {
        const idx = result.indexOf(original);
        if (idx !== -1) {
            result = result.slice(0, idx) + replacement + result.slice(idx + original.length);
        }
    }

    mathShapes.sort((a, b) => a.y - b.y);

    // Footer shapes start at ~95% of slide height (Marp standard template: y≈6501600 in 6858000px).
    // Use 93% as the threshold — safely below the footer, leaving room for any Marp theme variant.
    // Shapes at y >= footerY are excluded from shifting and from the available-space calculation.
    const footerY = Math.round(slideCy * 0.93);

    for (let idx = 0; idx < mathShapes.length; idx++) {
        const { y: shapeY, estimatedCy } = mathShapes[idx];

        const nextY     = findNearestYBelow(result, shapeY);
        const available = nextY - shapeY;
        const overflow  = estimatedCy - available;

        if (overflow > 0) {
            const lowestBottom = findLowestShapeBottom(result, shapeY, footerY);
            const maxShift     = Math.max(0, slideCy - lowestBottom - 50000);
            const actualShift  = Math.min(overflow, maxShift);
            if (actualShift > 0) {
                result = shiftShapesBelow(result, shapeY, actualShift, footerY);
                for (let j = idx + 1; j < mathShapes.length; j++) {
                    if (mathShapes[j].y > shapeY) {
                        mathShapes[j] = { ...mathShapes[j], y: mathShapes[j].y + actualShift };
                    }
                }
            }
        }
    }
    return result;
}

/** Estimates rendered OMML formula height in EMU from font size and structural complexity. */
function estimateOmmlHeightEmu(omml: string, szHundredthsPt: number): number {
    // Base single-line height: font size × 1.3 (includes typical ascenders/descenders)
    const base = (szHundredthsPt / 100) * 12700 * 1.3;
    const hasFraction  = /<m:f\b/.test(omml);
    // Count nesting depth: each undOvr nary (∑/∏) nests one level taller
    const undOvrCount  = (omml.match(/undOvr/g) || []).length;
    const hasSubSup    = /subSup/.test(omml);
    const hasRadical   = /<m:rad\b/.test(omml);
    // groupChr = underbrace/overbrace with annotation; adds brace + label height on top
    const hasGroupChr  = /<m:groupChr\b/.test(omml);
    let factor = 1.0;
    // Base factor: accurate estimate of formula visual height (independent of groupChr)
    if (hasFraction && undOvrCount > 1) { factor = 4.5; }
    else if (hasFraction && undOvrCount > 0) { factor = 4.5; }
    else if (undOvrCount > 1) { factor = 4.5; }             // nested sums (∑∑): much taller
    else if (undOvrCount === 1) { factor = 3.0; }           // single ∑ with display limits
    else if (hasFraction) { factor = 3.0; }
    else if (hasSubSup || hasRadical) { factor = 2.2; }
    // Underbrace/overbrace: groupChr brace extends ~0.5x below formula, and the annotation
    // is injected as a separate <a:p> paragraph (~1.0x height) in the same shape.
    // Total extra = ~1.5x. Applied only to formulas with underbrace/overbrace.
    if (hasGroupChr) { factor += 1.5; }
    return Math.round(base * factor);
}

/** Scans all non-math shapes and returns the most frequently used text font size (hundredths-pt). */
function findBodyFontSize(xml: string): number {
    const szCounts = new Map<number, number>();
    const spRe = /<p:sp>([\s\S]*?)<\/p:sp>/g;
    let spM: RegExpExecArray | null;
    while ((spM = spRe.exec(xml)) !== null) {
        const inner = spM[1];
        if (inner.includes('a14:m')) { continue; }  // skip math shapes
        const szRe = /\bsz="(\d+)"/g;
        let szM: RegExpExecArray | null;
        while ((szM = szRe.exec(inner)) !== null) {
            const sz = parseInt(szM[1], 10);
            if (sz >= 800 && sz <= 4400) {
                szCounts.set(sz, (szCounts.get(sz) || 0) + 1);
            }
        }
    }
    if (szCounts.size === 0) { return 1800; }
    let bestSz = 1800;
    let bestCount = 0;
    for (const [sz, count] of szCounts) {
        if (count > bestCount) { bestCount = count; bestSz = sz; }
    }
    return bestSz;
}

/** Sets the cy attribute on the <a:ext> element inside a <p:sp> shape. */
function setShapeCy(spXml: string, cy: number): string {
    return spXml.replace(/(<a:ext\b[^>]*\bcy=")[^"]*"/, `$1${cy}"`);
}

/** Downgrades sz="N" font-size attributes inside a shape to the given value.
 *  Only replaces values ABOVE sz (fixes LibreOffice's 2000→bodySz inflation).
 *  Values already below sz (e.g. annotation paragraphs at 1200) are left alone. */
function normalizeShapeSz(spXml: string, sz: number): string {
    return spXml.replace(/\bsz="(\d+)"/g, (_m, n) =>
        parseInt(n, 10) > sz ? `sz="${sz}"` : _m
    );
}

/** Returns the smallest y > thresholdY among all <a:off y="..."/> in the slide XML. */
function findNearestYBelow(xml: string, thresholdY: number): number {
    const re = /<a:off\b[^>]*\by="(\d+)"/g;
    let m: RegExpExecArray | null;
    let nearest = Infinity;
    while ((m = re.exec(xml)) !== null) {
        const y = parseInt(m[1], 10);
        if (y > thresholdY) { nearest = Math.min(nearest, y); }
    }
    return nearest === Infinity ? thresholdY + 10_000_000 : nearest;
}

/** Returns the maximum (y + cy) for shapes whose y is in [minShapeY, maxShapeY). */
function findLowestShapeBottom(xml: string, minShapeY: number = 0, maxShapeY: number = Infinity): number {
    const re = /<a:off\b[^>]*\by="(\d+)"[^>]*\/>\s*<a:ext\b[^>]*\bcy="(\d+)"/g;
    let m: RegExpExecArray | null;
    let lowest = 0;
    while ((m = re.exec(xml)) !== null) {
        const y = parseInt(m[1], 10);
        if (y > minShapeY && y < maxShapeY) {
            lowest = Math.max(lowest, y + parseInt(m[2], 10));
        }
    }
    return lowest;
}

/** Increments all <a:off y="..."/> where thresholdY < y < maxY by shiftEmu (in-place by regex). */
function shiftShapesBelow(xml: string, thresholdY: number, shiftEmu: number, maxY: number = Infinity): string {
    return xml.replace(/(<a:off\b[^>]*\by=")(\d+)("[^>]*\/>)/g, (m, pre, y, post) => {
        const yVal = parseInt(y, 10);
        return (yVal > thresholdY && yVal < maxY) ? `${pre}${yVal + shiftEmu}${post}` : m;
    });
}

// ─── Paragraph processing ─────────────────────────────────────────────────────

/**
 * Processes a single <a:p> paragraph: merges text across runs, detects placeholders,
 * and reconstructs the paragraph with OMML elements in place of placeholders.
 */
function processParagraph(paraXml: string, paraContent: string, formulaMap: Map<string, ExtractedMath>, centerAlign?: boolean): string {
    // Extract paragraph-level properties (preserved verbatim).
    // Use two-branch regex: self-closing OR element with children.
    const pPrMatch = /<a:pPr[^>]*\/>|<a:pPr[\s\S]*?<\/a:pPr>/.exec(paraContent);
    const endParaMatch = /<a:endParaRPr[^>]*\/>|<a:endParaRPr[\s\S]*?<\/a:endParaRPr>/.exec(paraContent);
    const pPr = pPrMatch ? pPrMatch[0] : '';
    const endParaRPr = endParaMatch ? endParaMatch[0] : '';

    // Collect all <a:r> runs: their text and run-property XML
    const runs: { text: string; rPr: string }[] = [];
    const runRe = /<a:r>([\s\S]*?)<\/a:r>/g;
    let rm: RegExpExecArray | null;
    while ((rm = runRe.exec(paraContent)) !== null) {
        const inner = rm[1];
        const textMatch = /<a:t[^>]*>([^<]*)<\/a:t>/.exec(inner);
        const rPrMatch = /(<a:rPr[^>]*\/>|<a:rPr[\s\S]*?<\/a:rPr>)/.exec(inner);
        runs.push({
            text: textMatch ? decodeXmlEntities(textMatch[1]) : '',
            rPr: rPrMatch ? rPrMatch[1] : '',
        });
    }

    const combinedText = runs.map(r => r.text).join('');

    // Check if this paragraph contains any placeholder
    let hasPlaceholder = false;
    for (const key of formulaMap.keys()) {
        if (combinedText.includes(key)) { hasPlaceholder = true; break; }
    }
    if (!hasPlaceholder) { return paraXml; }

    // Build run segments: map character positions to original rPr so we can preserve
    // per-run formatting (bold, italic, etc.) for text between/around placeholders.
    const runSegments: { start: number; end: number; rPr: string }[] = [];
    let runPos = 0;
    for (const run of runs) {
        runSegments.push({ start: runPos, end: runPos + run.text.length, rPr: run.rPr });
        runPos += run.text.length;
    }
    const fallbackRPr = runs.find(r => r.rPr)?.rPr ?? '';

    const newContent = buildParagraphContent(combinedText, runSegments, fallbackRPr, formulaMap);
    const effectivePPr = centerAlign ? ensureCenteredPPr(pPr) : pPr;
    let primaryPara = `<a:p>${effectivePPr}${newContent}${endParaRPr}</a:p>`;

    // Extract underbrace annotation sentinels (\x00ANNOT_START\x00...\x00ANNOT_END\x00) that
    // makeMunder embeds inside <m:oMath>. Each sentinel is stripped from the primary OMML and
    // re-emitted as a separate centered <a:p> paragraph so annotations never overlap the brace.
    if (primaryPara.includes('\x00ANNOT_START\x00')) {
        const annotParas: string[] = [];
        primaryPara = primaryPara.replace(/\x00ANNOT_START\x00([\s\S]*?)\x00ANNOT_END\x00/g,
            (_m, annotOmml: string) => {
                // spcBef: 20pt spacing above to clear the brace character below the formula.
                // groupChr(pos=bot) visually extends below its declared paragraph height (PowerPoint
                // bounding-box bug). 20pt compensates for the brace extension so annotation doesn't
                // overlap. defRPr sz=1200: annotation at 12pt (one size smaller than body ~16.5pt).
                // normalizeShapeSz only downscales, so sz=1200 < bodySz is preserved as-is.
                // Render annotation as plain text (not OMML) — PowerPoint ignores <a:spcBef>
                // on paragraphs containing only <a14:m> OMML objects.
                const annotText = annotOmml.replace(/<[^>]+>/g, '').trim();
                annotParas.push(
                    `<a:p>` +
                    `<a:pPr algn="ctr"><a:spcBef><a:spcPts val="2000"/></a:spcBef></a:pPr>` +
                    `<a:r><a:rPr lang="en-US" sz="1200" i="1"/><a:t>${xmlEscapeAttr(annotText)}</a:t></a:r>` +
                    `</a:p>`
                );
                return '';
            }
        );
        return primaryPara + annotParas.join('');
    }

    return primaryPara;
}

/**
 * Emits text for [start, end) of combinedText, splitting across original run boundaries
 * to preserve per-run formatting (bold, italic, font, etc.).
 */
function emitTextRange(
    text: string,
    start: number,
    end: number,
    runSegments: { start: number; end: number; rPr: string }[],
    fallbackRPr: string,
): string {
    let out = '';
    for (const seg of runSegments) {
        if (seg.end <= start || seg.start >= end) { continue; }
        const segStart = Math.max(start, seg.start);
        const segEnd = Math.min(end, seg.end);
        const segText = text.slice(segStart, segEnd);
        if (segText) { out += makeTextRun(segText, seg.rPr || fallbackRPr); }
    }
    return out;
}

/**
 * Splits combinedText at placeholder boundaries, emitting OMML for formulas and
 * preserving original per-run rPr for surrounding text.
 */
function buildParagraphContent(
    text: string,
    runSegments: { start: number; end: number; rPr: string }[],
    fallbackRPr: string,
    formulaMap: Map<string, ExtractedMath>,
): string {
    const hits: { start: number; end: number; formula: ExtractedMath }[] = [];
    for (const [key, formula] of formulaMap) {
        let pos = text.indexOf(key);
        while (pos !== -1) {
            hits.push({ start: pos, end: pos + key.length, formula });
            pos = text.indexOf(key, pos + key.length);
        }
    }
    hits.sort((a, b) => a.start - b.start);

    let out = '';
    let cursor = 0;
    let prevWasOmml = false;
    for (const hit of hits) {
        if (hit.start > cursor) {
            const between = text.slice(cursor, hit.start);
            // When two inline formulas are adjacent or only whitespace-separated,
            // insert em-spaces (U+2003) for visible separation — ASCII spaces collapse
            if (prevWasOmml && between.trim() === '') {
                // ASCII spaces (any count) collapse in PowerPoint adjacent to OMML — use em-spaces
                out += makeTextRun('   ', fallbackRPr);
            } else {
                out += emitTextRange(text, cursor, hit.start, runSegments, fallbackRPr);
            }
        } else if (prevWasOmml) {
            // Consecutive OMML elements with no text between — insert gap
            out += makeTextRun('   ', fallbackRPr);
        }
        try {
            // PPTX math structure: <a14:m> wraps <m:oMath> inside <a:p>
            // (bare <m:oMath> without <a14:m> is silently ignored by PowerPoint)
            const omml = latexToOmml(hit.formula.latex, hit.formula.isDisplay);
            out += `<a14:m>${omml}</a14:m>`;
            prevWasOmml = true;
        } catch {
            out += makeTextRun(hit.formula.placeholder, fallbackRPr);
            prevWasOmml = false;
        }
        cursor = hit.end;
    }
    if (cursor < text.length) {
        out += emitTextRange(text, cursor, text.length, runSegments, fallbackRPr);
    }
    return out;
}

function ensureCenteredPPr(pPr: string): string {
    if (!pPr) { return '<a:pPr algn="ctr"/>'; }
    if (/algn=/.test(pPr)) { return pPr.replace(/algn="[^"]*"/, 'algn="ctr"'); }
    return pPr.replace(/<a:pPr/, '<a:pPr algn="ctr"');
}

function makeTextRun(text: string, rPr: string): string {
    if (!text) { return ''; }
    const spaceAttr = (text[0] === ' ' || text[text.length - 1] === ' ') ? ' xml:space="preserve"' : '';
    return `<a:r>${rPr}<a:t${spaceAttr}>${xmlEscapeAttr(text)}</a:t></a:r>`;
}

function xmlEscapeAttr(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeXmlEntities(text: string): string {
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ─── Speaker Notes Injection ─────────────────────────────────────────────────

function xmlEscapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildNotesSlideXml(noteText: string): string {
    const paras = noteText.split('\n')
        .map(line => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xmlEscapeText(line)}</a:t></a:r></a:p>`)
        .join('\n          ');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Slide Image Placeholder 1"/>
          <p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="sldImg"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr/>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Notes Placeholder 2"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr/>
        <p:txBody>
          <a:bodyPr/><a:lstStyle/>
          ${paras}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;
}

function buildNotesSlideRelsXml(slideNum: string): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${slideNum}.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>
</Relationships>`;
}

function buildNotesMasterXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notesMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Slide Image Placeholder 1"/>
          <p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="sldImg"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="4525963" cy="3645963"/></a:xfrm></p:spPr>
      </p:sp>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Notes Placeholder 2"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="4021963"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
  <p:txStyles><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:notesMaster>`;
}

function buildNotesMasterRelsXml(): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

/**
 * Post-process PPTX to inject speaker notes into each slide.
 * Creates notesSlide XML files and wires up all required relationships.
 */
async function injectSpeakerNotes(pptxPath: string, notes: string[]): Promise<void> {
    if (notes.every(n => !n)) { return; }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));

    // Determine ordered slide filenames from presentation.xml + its rels
    const presRelsXml: string = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
    const presXml: string = await zip.file('ppt/presentation.xml')!.async('string');

    // rId -> relative slide path (e.g. "slides/slide1.xml")
    const rIdToSlide = new Map<string, string>();
    for (const m of presRelsXml.matchAll(/<Relationship\s+Id="([^"]+)"\s+Type="[^"]*\/slide"\s+Target="([^"]+)"/g)) {
        rIdToSlide.set(m[1], m[2]);
    }

    // Ordered rIds from sldIdLst
    const sldIdOrder: string[] = [];
    for (const m of presXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
        sldIdOrder.push(m[1]);
    }

    const orderedSlideFiles = sldIdOrder.map(rId => rIdToSlide.get(rId)).filter(Boolean) as string[];

    // Ensure notes master exists
    const hasMaster = !!zip.file('ppt/notesMasters/notesMaster1.xml');
    if (!hasMaster) {
        zip.file('ppt/notesMasters/notesMaster1.xml', buildNotesMasterXml());
        zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', buildNotesMasterRelsXml());
    }

    let contentTypesXml: string = await zip.file('[Content_Types].xml')!.async('string');
    let presRelsUpdated = presRelsXml;
    let modified = false;

    for (let i = 0; i < orderedSlideFiles.length && i < notes.length; i++) {
        const note = notes[i];
        if (!note) { continue; }

        const slideRelPath = orderedSlideFiles[i]; // e.g. "slides/slide1.xml"
        const slideNumMatch = slideRelPath.match(/slide(\d+)\.xml$/i);
        if (!slideNumMatch) { continue; }
        const slideNum = slideNumMatch[1];

        const slideRelsFile = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
        const notesFile = `ppt/notesSlides/notesSlide${slideNum}.xml`;
        const notesRelsFile = `ppt/notesSlides/_rels/notesSlide${slideNum}.xml.rels`;

        // Write notes slide
        zip.file(notesFile, buildNotesSlideXml(note));
        zip.file(notesRelsFile, buildNotesSlideRelsXml(slideNum));

        // Wire notes slide into the slide's rels file
        let slideRelsXml: string = (await zip.file(slideRelsFile)?.async('string')) ??
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
        if (!slideRelsXml.includes('notesSlide')) {
            const notesRelXml = `<Relationship Id="rIdNotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${slideNum}.xml"/>`;
            slideRelsXml = slideRelsXml.includes('</Relationships>')
                ? slideRelsXml.replace('</Relationships>', `  ${notesRelXml}\n</Relationships>`)
                : slideRelsXml.replace('/>', `>\n  ${notesRelXml}\n</Relationships>`);
            zip.file(slideRelsFile, slideRelsXml);
        }

        // Register notes slide content type
        const notesPartName = `/ppt/notesSlides/notesSlide${slideNum}.xml`;
        if (!contentTypesXml.includes(notesPartName)) {
            contentTypesXml = contentTypesXml.replace(
                '</Types>',
                `  <Override PartName="${notesPartName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>\n</Types>`
            );
        }

        modified = true;
    }

    if (!modified) { return; }

    // Register notes master content type and presentation relationship if we just created it
    if (!hasMaster) {
        const masterPartName = '/ppt/notesMasters/notesMaster1.xml';
        if (!contentTypesXml.includes(masterPartName)) {
            contentTypesXml = contentTypesXml.replace(
                '</Types>',
                `  <Override PartName="${masterPartName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>\n</Types>`
            );
        }
        if (!presRelsUpdated.includes('notesMaster')) {
            presRelsUpdated = presRelsUpdated.replace(
                '</Relationships>',
                `  <Relationship Id="rIdNM1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>\n</Relationships>`
            );
            zip.file('ppt/_rels/presentation.xml.rels', presRelsUpdated);
        }
    }

    zip.file('[Content_Types].xml', contentTypesXml);

    const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(pptxPath, output);
}

// Export for pre-warming caches at startup
export { isLibreOfficeInstalled, marpSupportsEditablePptx };
