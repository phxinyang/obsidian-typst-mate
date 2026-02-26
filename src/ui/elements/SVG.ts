import { MarkdownView, Notice } from 'obsidian';
import { BASE_COLOR_VAR } from '@/constants';
import { jumpFromClickPlugin } from '@/editor/shared/extensions/actions/JumpFromClick';
import type { Diagnostic, SVGResult } from '@/libs/worker';
import TypstElement from './Typst';

export default class TypstSVGElement extends TypstElement {
  /** Cross-instance cache: last successfully used parent width (px). */
  private static savedFitWidthPx: number | null = null;

  private renderSeq = 0;
  private lockedWidthPx: number | null = null;
  private recalcTimer: number | null = null;

  // --- helpers ---------------------------------------------------------------

  private isFitMode() {
    return this.kind !== 'inline' && this.processor.fitToParentWidth && !this.source.includes('<br>');
  }

  /** Read parent width now; returns null when unavailable. */
  private readParentWidthPx(): number | null {
    const w = this.parentElement?.getBoundingClientRect().width;
    return Number.isFinite(w) && w !== undefined && w > 0 ? w : null;
  }

  /** Resolve the width (px) to use for the current render. */
  private resolveWidthPx(): number | null {
    return this.lockedWidthPx ?? TypstSVGElement.savedFitWidthPx;
  }

  /** Build the Typst input, injecting `#let WIDTH` when valid. */
  private buildInput(): string {
    const formatted = this.format();
    if (!this.isFitMode()) return formatted;

    const wpx = this.resolveWidthPx();
    if (wpx === null || !Number.isFinite(wpx) || wpx <= 0)
      return formatted.replaceAll('width: WIDTH', 'width: auto');

    return (
      `#let WIDTH = ${(wpx * 3) / 4}pt\n` +
      formatted.replaceAll('width: auto', 'width: WIDTH')
    );
  }

  /** Force a fit-width rerender with the given px value. */
  private refit(widthPx: number) {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;

    this.lockedWidthPx = widthPx;
    TypstSVGElement.savedFitWidthPx = widthPx;

    const input =
      `#let WIDTH = ${(widthPx * 3) / 4}pt\n` +
      this.format().replaceAll('width: auto', 'width: WIDTH');

    const seq = ++this.renderSeq;
    const res = this.plugin.typst.svg(
      input, this.kind, this.id, this.plugin.settings.enableSvgTextSelection,
    ) as Promise<SVGResult>;

    res
      .then((r) => { if (seq === this.renderSeq) this.postProcess(r); })
      .catch((e: Diagnostic[]) => { if (seq === this.renderSeq) this.handleError(e); });
  }

  // --- layout-change handlers ------------------------------------------------

  private onLayoutChange = () => {
    if (!this.isFitMode() || !this.isConnected) return;
    if (this.recalcTimer !== null) clearTimeout(this.recalcTimer);
    this.recalcTimer = window.setTimeout(() => {
      this.recalcTimer = null;
      if (!this.isConnected) return;
      const w = this.readParentWidthPx();
      if (w !== null) this.refit(w);
    }, 150);
  };

  private onBeforePrint = () => {
    if (!this.isFitMode() || !this.isConnected) return;
    const w = this.readParentWidthPx();
    if (w !== null) this.refit(w);
  };

  // --- lifecycle -------------------------------------------------------------

  override connectedCallback() {
    window.addEventListener('resize', this.onLayoutChange);
    window.addEventListener('beforeprint', this.onBeforePrint);

    this.addEventListener('contextmenu', (event) => {
      const svg = this.querySelector('svg');
      if (!svg) return;

      event.preventDefault();
      this.menu.showAtPosition({ x: event.pageX, y: event.pageY });
    });

    this.addEventListener('click', async (event) => {
      if (this.kind !== 'codeblock') return; // TODO: 不安定

      const svg = this.querySelector('svg');
      if (!svg) return;

      const rect = svg.getBoundingClientRect();
      const x = (event.clientX - rect.left) / (rect.width / svg.viewBox.baseVal.width);
      const y = (event.clientY - rect.top) / (rect.height / svg.viewBox.baseVal.height);

      await this.plugin.typst.svg(this.format(), this.kind, this.id, this.plugin.settings.enableSvgTextSelection); // フレーム生成のための副作用
      const result = await this.plugin.typst.jumpFromClick(x, y);
      if (result) {
        const view = this.plugin.app.workspace.getActiveFileView();
        if (!(view instanceof MarkdownView)) return;
        view.editor.cm.plugin(jumpFromClickPlugin)?.jumpTo(result, this);
      }
    });
  }

  override disconnectedCallback() {
    window.removeEventListener('resize', this.onLayoutChange);
    window.removeEventListener('beforeprint', this.onBeforePrint);
    if (this.recalcTimer !== null) {
      clearTimeout(this.recalcTimer);
      this.recalcTimer = null;
    }
  }

  constructor() {
    super();
    this.menu.addSeparator();
    this.menu.addItem((item) => {
      item.setTitle('Copy as SVG (Obsidian Theme)').onClick(async () => {
        if (this.isErr) return;

        const bodyStyles = getComputedStyle(document.body);
        const baseColor = bodyStyles.getPropertyValue('--text-normal').trim();

        const svg = this.innerHTML.replaceAll(`var(${BASE_COLOR_VAR})`, baseColor);
        await copySVGToClipboard(svg);

        new Notice('Copied to clipboard!');
      });
    });
    this.menu.addItem((item) => {
      item.setTitle('Copy as SVG (Typst Default)').onClick(async () => {
        if (this.isErr) return;

        const svg = this.innerHTML.replaceAll(`var(${BASE_COLOR_VAR})`, '#000000');
        await copySVGToClipboard(svg);

        new Notice('Copied to clipboard!');
      });
    });
    this.menu.addSeparator();
    this.menu.addItem((item) => {
      item.setTitle('Copy as PNG (Transparent)').onClick(async () => {
        if (this.isErr) return;

        const bodyStyles = getComputedStyle(document.body);
        const baseColor = bodyStyles.getPropertyValue('--text-normal').trim();

        const svg = this.innerHTML.replaceAll(`var(${BASE_COLOR_VAR})`, baseColor);
        const pngBlob = await SVGToPNG(svg, this);

        if (pngBlob) {
          await copyPNGToClipboard(pngBlob);
          new Notice('Copied to clipboard!');
        } else new Notice('Failed to convert SVG to PNG');
      });
    });
    this.menu.addItem((item) => {
      item.setTitle('Copy as PNG (Opaque)').onClick(async () => {
        if (this.isErr) return;

        const bodyStyles = getComputedStyle(document.body);
        const baseColor = bodyStyles.getPropertyValue('--text-normal').trim();
        const backgroundColor = bodyStyles.getPropertyValue('--background-primary').trim();

        const svg = this.innerHTML.replaceAll(`var(${BASE_COLOR_VAR})`, baseColor);
        const pngBlob = await SVGToPNG(svg, this, backgroundColor);

        if (pngBlob) {
          await copyPNGToClipboard(pngBlob);
          new Notice('Copied to clipboard!');
        } else new Notice('Failed to convert SVG to PNG');
      });
    });
    this.menu.addSeparator();
    this.menu.addItem((item) => {
      item.setTitle('Copy as img tag (for embedding into Obsidian notes)').onClick(async () => {
        if (this.isErr) return;

        const bodyStyles = getComputedStyle(document.body);
        const baseColor = bodyStyles.getPropertyValue('--text-normal').trim();

        const svg = this.innerHTML.replaceAll(`var(${BASE_COLOR_VAR})`, baseColor).replaceAll('\n', '');
        const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        const tag = `<img src="${dataUrl}">`;
        await navigator.clipboard.writeText(tag);

        new Notice('Copied to clipboard!');
      });
    });
  }

  async render() {
    // Lock width on first render when fit-mode is active
    if (this.isFitMode() && this.lockedWidthPx === null) {
      const w = this.readParentWidthPx();
      if (w !== null) {
        this.lockedWidthPx = w;
        TypstSVGElement.savedFitWidthPx = w;
      }
    }

    const input = this.buildInput();

    try {
      const result = this.plugin.typst.svg(input, this.kind, this.id, this.plugin.settings.enableSvgTextSelection);
      const seq = ++this.renderSeq;

      if (result instanceof Promise) {
        if (this.isFitMode() && this.lockedWidthPx === null) {
          // Width wasn't available yet — use observer to grab it once
          this.noDiag = true;
          this.plugin.observer.register(
            this,
            (entry: ResizeObserverEntry) => {
              if (this.lockedWidthPx !== null) return; // already locked
              const w =
                Number.isFinite(entry.contentRect.width) && entry.contentRect.width > 0
                  ? entry.contentRect.width
                  : this.readParentWidthPx();
              if (w !== null) this.refit(w);
            },
            300,
          );
        }

        result
          .then((r: SVGResult) => { if (seq === this.renderSeq) this.postProcess(r); })
          .catch((e: Diagnostic[]) => { if (seq === this.renderSeq) this.handleError(e); });
      } else this.postProcess(result);
    } catch (err) {
      this.handleError(err as Diagnostic[]);
    }

    return this;
  }

  override postProcess(result: SVGResult) {
    super.postProcess(result);
    this.innerHTML = result.svg;
  }
}

async function copySVGToClipboard(svgContent: string) {
  // ? ClipboardItem.supports は対応していないブラウザのために使わない
  try {
    const svgBlob = new Blob([svgContent], { type: 'image/svg+xml' });
    const txtBlob = new Blob([svgContent], { type: 'text/plain' });

    const item = new ClipboardItem({ 'image/svg+xml': svgBlob, 'text/plain': txtBlob });
    await navigator.clipboard.write([item]);
  } catch {
    navigator.clipboard.writeText(svgContent);
  }
}

async function copyPNGToClipboard(pngBlob: Blob) {
  try {
    const item = new ClipboardItem({ 'image/png': pngBlob });
    await navigator.clipboard.write([item]);
  } catch {
    navigator.clipboard.writeText(pngBlob.toString());
  }
}

async function SVGToPNG(
  svgContent: string,
  svgElement: HTMLElement,
  backgroundColor?: string,
  scale = 2,
): Promise<Blob | null> {
  const svgChild = svgElement.querySelector('svg') as SVGGraphicsElement | null;
  if (!svgChild) return null;

  let { width, height } = svgChild.getBBox();
  width *= scale;
  height *= scale;

  const svgBlob = new Blob([svgContent], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(svgBlob);

  try {
    const img = await loadImage(url);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (backgroundColor) {
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas);
    return blob;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function loadImage(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();

  return img;
}

async function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
}
