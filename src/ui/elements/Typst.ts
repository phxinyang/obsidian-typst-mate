import { MarkdownView, Menu, Notice } from 'obsidian';

import { DEFAULT_FONT_SIZE } from '@/constants';
import { getActiveRegion, getLastRegion } from '@/editor/shared/extensions/core/TypstMate';
import { updateDiagnosticEffect } from '@/editor/shared/extensions/decorations/Diagnostic';
import type { Processor, ProcessorKind } from '@/libs/processor';
import type { Diagnostic, SVGResult } from '@/libs/worker';
import type ObsidianTypstMate from '@/main';
import { DiagnosticModal } from '../modals/diagnostic';

export default abstract class TypstElement extends HTMLElement {
  kind!: ProcessorKind;
  source!: string;
  processor!: Processor;

  offset!: number;
  noDiag!: boolean;

  plugin!: ObsidianTypstMate;

  isErr = true;

  menu = new Menu().addItem((item) => {
    item.setTitle('Copy as script').onClick(() => {
      const code = this.format().replaceAll(
        'fontsize',
        `${(this.plugin.app.vault.config.baseFontSize ?? DEFAULT_FONT_SIZE) / 1.25}pt`,
      );
      navigator.clipboard.writeText(code);
      new Notice('Copied to clipboard!');
    });
  });

  abstract render(): Promise<this>;

  private clearErrorIndicator() {
    this.querySelector('.typstmate-error-indicator')?.remove();
    this.removeClass('typstmate-with-error-indicator');
  }

  private showErrorIndicator(err: Diagnostic[]) {
    const hintCount = err[0]?.hints?.length ?? 0;
    const message = `${err[0]?.message}${hintCount !== 0 ? ` [${hintCount} hints]` : ''}`;

    const diagEl = document.createElement('span');
    diagEl.className = 'typstmate-error-indicator';
    diagEl.textContent = '!';
    diagEl.title = message;
    diagEl.setAttribute('aria-label', message);

    if (hintCount !== 0) diagEl.addEventListener('click', () => new DiagnosticModal(this.plugin.app, err).open());

    this.addClass('typstmate-with-error-indicator');
    this.appendChild(diagEl);
  }

  postProcess(result: SVGResult) {
    this.isErr = false;
    this.clearErrorIndicator();

    // ? キャンバスなどで呼ばれたとき用
    const view = this.plugin.app.workspace.getActiveFileView();
    if (view instanceof MarkdownView)
      updateDiagnosticEffect(view.editor.cm, {
        // @ts-expect-error
        diags: result.diags,
        kind: this.kind,
        processor: this.processor,
        offset: this.offset,
        noDiag: this.noDiag,
      });

    this.plugin.typstManager.beforeKind = this.kind;
  }

  format() {
    let formatted = this.processor.format.replace('{CODE}', this.source);
    formatted = `${this.plugin.typstManager.preamble}\n${formatted}`;
    formatted = this.processor.noPreamble ? formatted : `${this.plugin.settings.preamble}\n${formatted}`;

    return formatted;
  }

  handleError(err: Diagnostic[]) {
    this.isErr = true;
    this.plugin.typstManager.beforeKind = this.kind;

    const view = this.plugin.app.workspace.getActiveFileView();
    let isOutsideNoteError = false;
    let hasActiveMathRegion = false;

    if (view instanceof MarkdownView) {
      const region = getActiveRegion(view.editor.cm) ?? getLastRegion(view.editor.cm);
      if (region && region.kind === this.kind) {
        hasActiveMathRegion = true;

        const { noPreamble, format } = this.processor;
        const offset =
          region.from -
          format.indexOf('{CODE}') -
          (noPreamble ? 0 : this.plugin.settings.preamble.length + 1) -
          this.plugin.typstManager.preamble.length -
          1;

        const diag = err[0];
        if (diag) {
          const mappedFrom = diag.from + offset;
          const mappedTo = diag.to + offset;
          isOutsideNoteError = !(region.from <= mappedFrom && mappedTo <= region.to);
        }
      }
    }

    if (view instanceof MarkdownView)
      updateDiagnosticEffect(view.editor.cm, {
        // @ts-expect-error
        diags: err,
        kind: this.kind,
        processor: this.processor,
        offset: this.offset,
        noDiag: this.noDiag,
      });

    if (this.plugin.settings.enableMathjaxFallback) {
      this.replaceChildren(
        this.plugin.originalTex2chtml(this.source, {
          display: this.kind !== 'inline',
        }),
      );
    } else {
      this.clearErrorIndicator();

      if (hasActiveMathRegion && !isOutsideNoteError) {
        this.innerHTML = this.innerHTML.replaceAll('--typst-base-color', '--text-faint');
        return;
      }

      const hasPreviousSVG = this.querySelector('svg') !== null;
      if (hasPreviousSVG && isOutsideNoteError) {
        this.showErrorIndicator(err);
        return;
      }

      const diagEl = document.createElement('span');
      diagEl.className = 'typstmate-error';

      const hintCount = err[0]?.hints?.length ?? 0;
      diagEl.textContent = `${err[0]?.message}${hintCount !== 0 ? ` [${hintCount} hints]` : ''}`;

      if (hintCount !== 0) diagEl.addEventListener('click', () => new DiagnosticModal(this.plugin.app, err).open());

      this.replaceChildren(diagEl);
    }
  }

  connectedCallback() {
    this.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.menu.showAtPosition({ x: event.pageX, y: event.pageY });
    });
  }
}
