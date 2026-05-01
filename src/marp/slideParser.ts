export interface SlideInfo {
    index: number;
    heading: string;
    cssClass: string;
    line: number;
}

export function isMarpFile(content: string): boolean {
    return /^---\s*\n[\s\S]*?marp:\s*true/m.test(content.slice(0, 500));
}

export function parseSlides(content: string): SlideInfo[] {
    if (!isMarpFile(content)) { return []; }

    const lines = content.split('\n');
    const slides: SlideInfo[] = [];

    let inFrontmatter = false;
    let frontmatterEnd = 0;
    for (let i = 0; i < lines.length; i++) {
        if (i === 0 && lines[i].trim() === '---') { inFrontmatter = true; continue; }
        if (inFrontmatter && lines[i].trim() === '---') { frontmatterEnd = i; break; }
    }

    let slideIndex = 1;
    let currentSlideStart = frontmatterEnd;
    let currentClass = '';
    let currentHeading = '';

    for (let i = frontmatterEnd + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '---') {
            slides.push({
                index: slideIndex,
                heading: currentHeading || `Slide ${slideIndex}`,
                cssClass: currentClass,
                line: currentSlideStart,
            });
            slideIndex++;
            currentSlideStart = i;
            currentClass = '';
            currentHeading = '';
            continue;
        }
        const classMatch = line.match(/<!--\s*_class:\s*([^\s-]+)/);
        if (classMatch && !currentClass) { currentClass = classMatch[1]; }
        const headingMatch = line.match(/^#+\s+(.+)/);
        if (headingMatch && !currentHeading) { currentHeading = headingMatch[1].trim(); }
    }

    slides.push({
        index: slideIndex,
        heading: currentHeading || `Slide ${slideIndex}`,
        cssClass: currentClass,
        line: currentSlideStart,
    });

    return slides;
}

export function parseSpeakerNotes(markdown: string): string[] {
    const lines = markdown.split('\n');
    const notes: string[] = [];
    let currentNotes: string[] = [];
    let inFrontmatter = false;
    let frontmatterDone = false;
    let inComment = false;
    let commentLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (i === 0 && line.trim() === '---') { inFrontmatter = true; continue; }
        if (inFrontmatter && line.trim() === '---') { inFrontmatter = false; frontmatterDone = true; continue; }
        if (inFrontmatter || !frontmatterDone) { continue; }

        if (line.trim() === '---') {
            notes.push(currentNotes.join('\n').trim());
            currentNotes = [];
            continue;
        }

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

        const singleMatch = line.match(/<!--\s*(.*?)\s*-->/);
        if (singleMatch) {
            const content = singleMatch[1];
            if (content && !content.match(/^_?\w+\s*:/)) {
                currentNotes.push(content);
            }
            continue;
        }

        const startMatch = line.match(/<!--\s*(.*)/);
        if (startMatch) {
            inComment = true;
            commentLines = [startMatch[1]];
            continue;
        }
    }
    notes.push(currentNotes.join('\n').trim());
    return notes;
}
