import hljsLightCss from 'highlight.js/styles/github.css?inline';
import {el} from './Dom.js';
import {hydrateMarkdownForExport} from './MarkdownPreview.js';

/**
 * Client-side "Export PDF" for a note. We render the note's markdown into
 * an offscreen container (reusing the exact viewer pipeline — code
 * highlighting, asset images, infographic/floorplan SVG), then hand that
 * finished subtree to a hidden same-origin iframe carrying a dedicated,
 * always-light print stylesheet and trigger the browser's print engine.
 *
 * Why print-to-PDF and not jsPDF/html2canvas: the browser prints vector
 * text with real pagination and hyphenation, reuses our styling, and
 * produces a small, crisp file. Canvas rasterization would be blurry and
 * huge. The user picks "Save as PDF" as the print destination.
 */

export interface PdfNote {
    id: string;
    title: string;
    content: string;
    tags?: readonly string[];
}

/**
 * Self-contained print stylesheet. Deliberately theme-independent (always
 * light) with hardcoded colours so the PDF looks the same regardless of the
 * app's current dark/light theme. hljs' light token colours are appended by
 * the caller.
 */
const PRINT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
@page { size: A4; margin: 18mm 16mm; }

.pdf-page {
    max-width: 178mm;
    margin: 0 auto;
    color: #1b1f24;
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}

.pdf-header {
    border-bottom: 2px solid #e5e8ec;
    padding-bottom: 14px;
    margin-bottom: 26px;
}
.pdf-title {
    font-size: 23pt;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.2;
    margin: 0;
    color: #10141a;
}
.pdf-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
}
.pdf-tag {
    font-size: 8.5pt;
    padding: 2px 9px;
    border: 1px solid #d6dbe1;
    border-radius: 999px;
    color: #55606c;
    background: #f6f8fa;
}

.md-preview-body { word-wrap: break-word; }
.md-preview-body > :first-child { margin-top: 0; }

.md-preview-body h1,
.md-preview-body h2,
.md-preview-body h3,
.md-preview-body h4,
.md-preview-body h5,
.md-preview-body h6 {
    color: #10141a;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.01em;
    margin: 1.5em 0 0.5em;
    break-after: avoid;
    page-break-after: avoid;
}
.md-preview-body h1 { font-size: 18pt; }
.md-preview-body h2 { font-size: 15pt; padding-bottom: 4px; border-bottom: 1px solid #eceff2; }
.md-preview-body h3 { font-size: 13pt; }
.md-preview-body h4 { font-size: 11.5pt; }

.md-preview-body p { margin: 0.7em 0; }

.md-preview-body a {
    color: #0b63c4;
    text-decoration: none;
    border-bottom: 1px solid rgba(11, 99, 196, 0.28);
}

.md-preview-body code {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    font-size: 9.5pt;
    background: #f2f4f6;
    padding: 1px 5px;
    border-radius: 4px;
    color: #263041;
}
.md-preview-body pre {
    background: #f6f8fa;
    border: 1px solid #e4e8ec;
    border-radius: 8px;
    padding: 12px 14px;
    margin: 0.9em 0;
    white-space: pre-wrap;
    word-break: break-word;
    break-inside: avoid;
    page-break-inside: avoid;
}
.md-preview-body pre code {
    background: transparent;
    padding: 0;
    font-size: 9.5pt;
    color: inherit;
}

.md-preview-body ul,
.md-preview-body ol { padding-left: 1.5em; margin: 0.7em 0; }
.md-preview-body li { margin: 0.25em 0; }

.md-preview-body blockquote {
    border-left: 3px solid #37a;
    margin: 0.9em 0;
    padding: 0.3em 0 0.3em 14px;
    color: #48525d;
    background: #f4f8fb;
    border-radius: 0 6px 6px 0;
    break-inside: avoid;
}

.md-preview-body table {
    border-collapse: collapse;
    margin: 0.9em 0;
    font-size: 9pt;
    width: 100%;
    /* Fixed layout is what stops a wide table from overflowing the page
       and getting clipped: columns are forced to share the page width and
       their contents wrap, instead of the table growing past A4. */
    table-layout: fixed;
}
.md-preview-body th,
.md-preview-body td {
    border: 1px solid #d8dce1;
    padding: 6px 9px;
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
    word-break: break-word;
}
.md-preview-body th { background: #f2f4f6; font-weight: 600; }
/* Let a tall table flow across pages, but never split a single row, and
   repeat the header on every page. */
.md-preview-body tr { break-inside: avoid; page-break-inside: avoid; }
.md-preview-body thead { display: table-header-group; }

.md-preview-body img,
.md-preview-body svg { max-width: 100%; height: auto; break-inside: avoid; }
.md-preview-body figure { margin: 0.9em 0; break-inside: avoid; }
.md-preview-body hr { border: none; border-top: 1px solid #e5e8ec; margin: 1.6em 0; }

.md-preview-body .wikilink {
    color: #8a6b00;
    background: #fbf2cf;
    padding: 1px 6px;
    border-radius: 4px;
    font-weight: 500;
    white-space: nowrap;
}
`;

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Is this text node inside a <code>/<pre> so we must not touch it. */
const insideCode = (node: Node): boolean => {
    let parent: Node | null = node.parentNode;
    while (parent !== null && parent.nodeType === Node.ELEMENT_NODE) {
        const tag = (parent as Element).tagName;
        if (tag === 'CODE' || tag === 'PRE') return true;
        parent = parent.parentNode;
    }
    return false;
};

/**
 * Turn literal `[[Target|Label]]` text left in the rendered output into
 * styled (non-clickable) wikilink chips, so the PDF matches the viewer's
 * look. Only the label (part after `|`) is shown; code spans are skipped.
 */
const styleWikilinks = (host: HTMLElement): void => {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let current = walker.nextNode();
    while (current !== null) {
        const text = current as Text;
        if (text.data.includes('[[') && !insideCode(text)) targets.push(text);
        current = walker.nextNode();
    }

    for (const text of targets) {
        WIKILINK_RE.lastIndex = 0;
        if (!WIKILINK_RE.test(text.data)) continue;
        WIKILINK_RE.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let last = 0;
        let match: RegExpExecArray | null;
        while ((match = WIKILINK_RE.exec(text.data)) !== null) {
            if (match.index > last) {
                frag.appendChild(document.createTextNode(text.data.slice(last, match.index)));
            }
            const raw = match[1] ?? '';
            const label = raw.includes('|') ? raw.slice(raw.indexOf('|') + 1) : raw;
            frag.appendChild(el('span', {class: 'wikilink', text: label.trim()}));
            last = match.index + match[0].length;
        }
        if (last < text.data.length) {
            frag.appendChild(document.createTextNode(text.data.slice(last)));
        }
        text.replaceWith(frag);
    }
};

/**
 * Last-resort fit for atomic blocks that still exceed the printable width
 * after CSS wrapping (wide SVG/infographic/floorplan, an unbreakable code
 * line, an oversized image). We wrap each such block and scale it down to
 * fit `maxWidth`, reserving the scaled height so surrounding content flows
 * correctly — the browser clips anything wider than the page, so scaling
 * is the only way to keep the whole block visible. Tables are handled by
 * `table-layout: fixed` and never land here.
 */
const fitWideBlocks = (doc: Document, root: HTMLElement, maxWidth: number): void => {
    const blocks = root.querySelectorAll<HTMLElement>(
        'pre, svg, img, .md-antv-infographic, .md-floorplan'
    );
    for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        const naturalWidth = Math.ceil(rect.width);
        if (naturalWidth <= maxWidth + 1 || naturalWidth === 0) continue;

        const scale = maxWidth / naturalWidth;
        const naturalHeight = rect.height;

        const wrap = doc.createElement('div');
        wrap.style.width = `${maxWidth}px`;
        wrap.style.height = `${Math.ceil(naturalHeight * scale)}px`;
        wrap.style.overflow = 'hidden';

        block.parentNode?.insertBefore(wrap, block);
        wrap.appendChild(block);
        block.style.transformOrigin = 'top left';
        block.style.transform = `scale(${scale})`;
    }
};

const nextFrame = (): Promise<void> =>
    new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

/** Resolve once every <img> under root has loaded (or errored). */
const waitForImages = async (root: ParentNode): Promise<void> => {
    const imgs = Array.from(root.querySelectorAll('img'));
    await Promise.all(imgs.map((img) =>
        img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), {once: true});
                img.addEventListener('error', () => resolve(), {once: true});
            })
    ));
};

/**
 * Render `note` and open the browser print dialog scoped to a hidden iframe.
 * Resolves once printing has been triggered (the dialog itself is the
 * browser's; the user chooses "Save as PDF"). Throws on render failure.
 */
export const exportNoteToPdf = async (note: PdfNote): Promise<void> => {
    // 1. Render the body offscreen but attached, so antv/mdfloor can size
    //    off a real width before we await their async passes.
    const stage = el('div', {
        style: {
            position: 'fixed',
            left: '-10000px',
            top: '0',
            width: '720px',
            pointerEvents: 'none',
            opacity: '0'
        },
        attrs: {'aria-hidden': 'true'}
    });
    const body = el('div', {class: 'md-preview-body'});
    stage.appendChild(body);
    document.body.appendChild(stage);

    try {
        await hydrateMarkdownForExport(body, note.content, note.id);
        styleWikilinks(body);
        await waitForImages(body);
    } catch (e) {
        stage.remove();
        throw e;
    }

    // 2. Hidden iframe carrying the print stylesheet. It must have a REAL
    //    width (not 0×0) and offscreen position, so its layout matches the
    //    printed page and we can measure which blocks overflow. 800px is
    //    comfortably wider than A4's printable area so the page lays out at
    //    its natural full width.
    const frame = el('iframe', {
        style: {
            position: 'fixed',
            left: '-10000px',
            top: '0',
            width: '800px',
            height: '1200px',
            border: '0',
            visibility: 'hidden'
        },
        attrs: {'aria-hidden': 'true', title: 'PDF export'}
    });
    document.body.appendChild(frame);

    const doc = frame.contentDocument;
    if (doc === null) {
        stage.remove();
        frame.remove();
        throw new Error('Could not open print frame');
    }

    doc.open();
    doc.write(
        '<!doctype html><html><head><meta charset="utf-8"></head>' +
        '<body><main class="pdf-page">' +
        '<header class="pdf-header"></header>' +
        '<div id="pdf-body-slot" class="md-preview-body"></div>' +
        '</main></body></html>'
    );
    doc.close();

    // Filename hint for the "Save as PDF" dialog.
    doc.title = note.title || 'note';

    const style = doc.createElement('style');
    style.textContent = `${PRINT_CSS}\n${hljsLightCss}`;
    doc.head.appendChild(style);

    // Header: title + tag chips.
    const header = doc.querySelector('.pdf-header');
    if (header !== null) {
        const h1 = doc.createElement('h1');
        h1.className = 'pdf-title';
        h1.textContent = note.title;
        header.appendChild(h1);

        const tags = note.tags ?? [];
        if (tags.length > 0) {
            const row = doc.createElement('div');
            row.className = 'pdf-tags';
            for (const tag of tags) {
                const chip = doc.createElement('span');
                chip.className = 'pdf-tag';
                chip.textContent = tag;
                row.appendChild(chip);
            }
            header.appendChild(row);
        }
    }

    // 3. Move the live, fully-rendered body into the iframe (adoptNode keeps
    //    any canvas backing store that cloneNode would drop).
    const slot = doc.getElementById('pdf-body-slot');
    if (slot !== null) {
        const adopted = doc.adoptNode(body);
        slot.replaceWith(adopted);
        adopted.className = 'md-preview-body';
        adopted.removeAttribute('id');
    }
    // `body` has been moved out of `stage`; the empty stage can go now.
    stage.remove();

    // 4. Let layout settle, images resolve, scale any block that still
    //    overflows the printable width, then print.
    await nextFrame();
    await waitForImages(doc);

    const page = doc.querySelector<HTMLElement>('.pdf-page');
    const printBody = doc.querySelector<HTMLElement>('.md-preview-body');
    if (page !== null && printBody !== null) {
        const maxWidth = printBody.clientWidth;
        if (maxWidth > 0) {
            fitWideBlocks(doc, page, maxWidth);
            await nextFrame();
        }
    }

    const win = frame.contentWindow;
    if (win === null) {
        frame.remove();
        throw new Error('Print frame lost its window');
    }

    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        frame.remove();
    };
    win.addEventListener('afterprint', cleanup, {once: true});
    // Fallback in case afterprint never fires (some browsers/print paths).
    window.setTimeout(cleanup, 60000);

    win.focus();
    win.print();
};
