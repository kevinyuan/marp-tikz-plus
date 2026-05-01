# Marp TikZ

Render TikZ/LaTeX diagrams inside Obsidian's reading view, and author full Marp slide presentations — complete with **Slide Navigator**, **Speaker Notes panel**, and one-click **PPTX export** with native math objects.

> Desktop only. Rendering runs locally via a WASM-based TeX engine — no internet required.

## Features

- **TikZ rendering** — Live SVG rendering of `tikz` fenced code blocks in reading view
- **Rich package support** — chemfig, circuitikz, pgfplots, tikz-cd, tikz-3dplot, amsmath, and more
- **Dark mode** — Automatic color inversion for dark themes
- **External file include** — Reference `.tikz` files with `%!include`; auto-refreshes on save
- **Smart caching** — Two-level cache (memory + persistent); unchanged diagrams load instantly
- **Marp preview** — Full slide rendering via `@marp-team/marp-core` (no other plugins required)
- **Slide Navigator** — Thumbnail sidebar; click any slide to jump to it in the editor
- **Speaker Notes panel** — Live notes extracted from Marp HTML comments
- **PPTX / PDF export** — Export Marp decks via marp-cli with native PowerPoint math (OMML), not images
- **CJK font injection** — Automatically injects Noto Sans SC so Chinese/Japanese/Korean text renders correctly in exported files

## Quick Start

### TikZ diagrams

Add a `tikz` fenced code block in any Markdown file:

````markdown
```tikz
\begin{document}
\begin{tikzpicture}
  \draw[thick, ->] (0,0) -- (2,0) node[right] {$x$};
  \draw[thick, ->] (0,0) -- (0,2) node[above] {$y$};
  \draw[blue, thick] (0,0) circle (1);
\end{tikzpicture}
\end{document}
```
````

Switch to **Reading view** — the diagram renders inline.

### Marp presentations

Add `marp: true` to the frontmatter:

````markdown
---
marp: true
---

# My Presentation

```tikz
\begin{document}
\begin{tikzpicture}
  \node[circle, draw] (a) at (0,0) {A};
  \node[circle, draw] (b) at (3,0) {B};
  \draw[->] (a) -- (b);
\end{tikzpicture}
\end{document}
```
````

Then open the **Marp preview**, **Slide Navigator**, or **Speaker Notes** via the command palette.

## Commands

Open the command palette (`Cmd+P` / `Ctrl+P`) and search for **Marp TikZ**:

| Command | Description |
|---------|-------------|
| Open Marp preview | Render the active file as Marp slides |
| Open Slide Navigator | Thumbnail sidebar for the active Marp deck |
| Open Speaker Notes | Notes panel extracted from HTML comments |
| Export Marp slides to PPTX | Export to editable `.pptx` |
| Export Marp slides to PDF | Export to `.pdf` |
| Refresh TikZ diagrams | Force re-render all diagrams in the active file |
| Clear TikZ cache | Wipe cache and force fresh rendering |
| Reset TikZJax engine | Reset the WASM TeX engine |

A ribbon icon (file-down) provides quick access to PPTX export.

## Marp Slide Navigator

When a Marp file is open, use **Open Slide Navigator** to open a sidebar with slide thumbnails. Click any thumbnail to move the editor cursor to that slide.

## Speaker Notes

Notes are extracted from HTML comments in your Markdown:

```markdown
<!-- This appears as a speaker note for the current slide -->
```

Use **Open Speaker Notes** to open the panel. Notes are shown per slide with prev/next navigation and a scrollable all-slides list.

## PPTX Export

**Prerequisites** (for PPTX / PDF export only):

- [marp-cli](https://github.com/marp-team/marp-cli) v4.1.0+: `npm install -g @marp-team/marp-cli`
- [LibreOffice](https://www.libreoffice.org/) (required by marp-cli for editable PPTX)

Export pipeline:

1. Render all TikZ diagrams to SVG
2. Run `marp-cli --pptx-editable` to produce a `.pptx`
3. Post-process: fix LibreOffice overlay shapes, inject native math (OMML), inject speaker notes
4. Save output next to the source file (timestamped)

### Math in PPTX

LaTeX math in slides is converted to **native PowerPoint math objects** (OMML), not images. Formulas are fully editable in PowerPoint and render crisply at any zoom level.

- Display math (`$$...$$`) is centered with automatic vertical space
- Inline math preserves `\quad`/`\qquad` spacing
- `\mathbf`, `\mathit`, `\hat`, `\sum`, `\prod`, `\int` and other accents/nary operators render natively

## External File Include

Store diagrams in separate `.tikz` files and reference them with `%!include`:

````markdown
```tikz
%!include diagrams/circuit.tikz
```
````

The included file should contain complete TikZ code:

```latex
\usepackage{circuitikz}
\begin{document}
\begin{circuitikz}
  \draw (0,0) to[battery1, l=$V$] (0,3)
        to[R=$R_1$] (3,3)
        to[R=$R_2$] (3,0)
        -- (0,0);
\end{circuitikz}
\end{document}
```

- Paths are relative to the Markdown file's directory
- The preview auto-refreshes when you save the included file

## Supported Packages

| Package | Purpose |
|---------|---------|
| chemfig | Chemical structures |
| circuitikz | Electronic circuits |
| pgfplots | Function plots and data charts |
| tikz-cd | Commutative diagrams |
| tikz-3dplot | 3D figures |
| amsmath, amssymb, amsfonts | Mathematical notation |
| array | Array and table structures |

## Settings

Open **Settings → Community Plugins → Marp TikZ**:

| Setting | Default | Description |
|---------|---------|-------------|
| Invert colors in dark mode | `true` | Invert diagram colors when Obsidian uses a dark theme |
| Render timeout (ms) | `15000` | Max time to wait per diagram; increase for complex diagrams |
| Include notes in PPTX | `true` | Embed speaker notes in the PowerPoint notes pane |
| Export format | `pptx` | Default export format (`pptx` or `pdf`) |

## Diagram Sizing in Marp

Marp renders slides at 1280×720. Diagrams may appear smaller than in standard reading view. Use TikZ's `scale` option to compensate:

```latex
\begin{tikzpicture}[scale=2]
  ...
\end{tikzpicture}
```

## Troubleshooting

**Diagrams not rendering** — Switch to Reading view (not Live Preview). Check that the code block uses the `tikz` language identifier.

**Slow rendering** — Increase the render timeout in plugin settings. Cached diagrams load instantly; only new/changed diagrams are re-rendered.

**Preview not updating** — Use **Refresh TikZ diagrams**. If that doesn't help, try **Reset TikZJax engine**.

**CJK text in exported files** — CJK font injection is automatic. If Chromium still can't resolve the font, ensure you have internet access during export (the font is fetched from Google Fonts at export time).

**PPTX export fails** — Confirm `marp-cli` and LibreOffice are installed and accessible from your `PATH`.

## Known Issues / TODO

- **TikZ rendering broken in Obsidian** — All `tikz` blocks fail with "Invalid package /Applications/Obsidian.app/Contents/Resources/electron". Root cause: `__dirname` in Electron's renderer process resolves to the Electron binary directory instead of the plugin root, so `node-tikzjax` bootstrap cannot locate the `tex/` files. Attempted fix: patch bootstrap.js at bundle time to use `globalThis.__MARP_TIKZ_TEX_DIR` (set from Obsidian Plugin API in `onload()`). Status: patch applied but rendering still fails — likely the `load()` function hits another `__dirname`-based path or the `tex_files.tar.gz` extraction is failing silently. Next: add more granular logging inside bootstrap's `load()` to pinpoint which file operation fails.

## Acknowledgments

- [node-tikzjax](https://github.com/drgrice1/node-tikzjax) by @drgrice1 — WASM-based TeX rendering engine
- [TikZJax](https://github.com/kisonecat/tikzjax) by @kisonecat — original browser-based TikZ compiler
- [obsidian-tikzjax](https://github.com/artisticat1/obsidian-tikzjax) by @artisticat1 — original Obsidian TikZ plugin
- [@marp-team/marp-core](https://github.com/marp-team/marp-core) — Marp slide rendering engine

## License

MIT — see [LICENSE](LICENSE) for details.
