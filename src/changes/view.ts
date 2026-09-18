// "Changes": what happened to this document since it was opened in this tab.
// A small pill shows the count; it opens a side-by-side before/after. The
// baseline lives in sessionStorage, so a reload keeps the history and a new tab
// starts a new one.

import { diffMarkdown, stripProofSpans, summarize, type BlockRow, type WordPart } from './diff';

export interface ChangesViewOptions {
  getSlug(): string | null;
  getMarkdown(): string;
}

const REFRESH_MS = 2000;
const COLLAPSE_AFTER = 2;

const ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4H5v16h3M16 4h3v16h-3M12 3v18"/></svg>';

const STEP_UP_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const STEP_DOWN_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const STYLE = `
.changes-toggle {
  all: unset;
  box-sizing: border-box;
  position: fixed;
  top: 18px;
  right: 16px;
  z-index: 8900;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--pl-paper-raised, #fff);
  color: var(--pl-text, #1B1D22);
  font: 500 13px/1 var(--pl-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  box-shadow: 0 4px 18px rgba(12, 14, 20, 0.1), 0 0 0 1px rgba(12, 14, 20, 0.06);
  cursor: pointer;
  transition: background 120ms ease;
}
.changes-toggle:hover { background: var(--pl-paper, #F7F6F3); }
.changes-toggle:focus-visible, .changes-dialog button:focus-visible { outline: 2px solid var(--pl-focus, #2346C7); outline-offset: 2px; }
.changes-count {
  min-width: 20px;
  padding: 3px 6px;
  border-radius: 999px;
  background: var(--pl-paper, #F7F6F3);
  color: var(--pl-text-muted, #5C6370);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
/* Ink, not an authorship colour: the count covers the author's edits and the agent's. */
.changes-toggle[data-dirty="true"] .changes-count { background: var(--pl-ink, #15171C); color: var(--pl-text-on-ink, #F4F5F7); }

.changes-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9500;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(21, 23, 28, 0.45);
  font-family: var(--pl-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
}
.changes-backdrop[hidden] { display: none; }
.changes-dialog {
  display: flex;
  flex-direction: column;
  width: min(1180px, 100%);
  max-height: 100%;
  border-radius: var(--pl-radius-card, 14px);
  background: var(--pl-paper-raised, #fff);
  color: var(--pl-text, #1B1D22);
  box-shadow: 0 24px 80px rgba(12, 14, 20, 0.35);
  overflow: hidden;
}
.changes-head {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(12, 14, 20, 0.08);
}
.changes-title { font-size: 17px; font-weight: 700; }
.changes-sub { margin-top: 3px; font-size: 13px; color: var(--pl-text-muted, #5C6370); }
.changes-head-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.changes-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--pl-radius-control, 9px);
  font-size: 13px;
  font-weight: 600;
  color: var(--pl-text, #1B1D22);
  box-shadow: inset 0 0 0 1px var(--pl-line-strong, rgba(21, 23, 28, 0.18));
  cursor: pointer;
}
.changes-btn:hover { background: var(--pl-paper, #F7F6F3); }
.changes-btn[data-primary] { background: var(--pl-ink, #15171C); color: var(--pl-text-on-ink, #F4F5F7); box-shadow: none; }
.changes-btn[data-primary]:hover { background: var(--pl-ink-raised, #23262E); }
.changes-btn[disabled] { opacity: 0.4; cursor: default; }
/* Step through the changed blocks, one at a time. */
.changes-step { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; }
.changes-step[hidden] { display: none; }
.changes-step .changes-btn { width: 32px; padding: 0; }
.changes-step-label { min-width: 52px; text-align: center; font-size: 13px; color: var(--pl-text-muted, #5C6370); font-variant-numeric: tabular-nums; }
.changes-cols, .changes-row { display: grid; grid-template-columns: 1fr 1fr; }
.changes-row + .changes-row { margin-top: 4px; }
.changes-cols {
  padding: 8px 20px 8px 35px;
  font-size: 12px;
  font-weight: 600;
  color: var(--pl-text-muted, #5C6370);
  background: var(--pl-paper, #F7F6F3);
  border-bottom: 1px solid var(--pl-line, rgba(21, 23, 28, 0.1));
}
.changes-cols > * + * { padding-left: 12px; }
.changes-body { overflow: auto; padding: 8px 20px 20px; scroll-behavior: smooth; }
.changes-cell {
  min-width: 0;
  padding: 8px 12px;
  font: 13px/1.6 ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-left: 3px solid transparent;
}
.changes-cell + .changes-cell { margin-left: 12px; }
.changes-row[data-kind="same"] .changes-cell { color: #6b7280; }
.changes-row[data-current="true"] .changes-cell { box-shadow: 0 0 0 2px var(--pl-text, #1B1D22); border-radius: 3px; }
/* Red and green say what kind of change it is, as they do in the document. */
.changes-cell[data-side="before"][data-tone="removed"] { background: #fef2f2; border-left-color: var(--pl-delete, #B42318); }
.changes-cell[data-side="after"][data-tone="added"] { background: #f0fdf4; border-left-color: var(--pl-insert, #15803D); }
.changes-cell[data-tone="empty"] { background: repeating-linear-gradient(135deg, #fafafa 0 6px, #f3f4f6 6px 12px); }
.changes-cell del { background: #fecaca; color: #7f1d1d; text-decoration: line-through; text-decoration-color: rgba(127, 29, 29, 0.5); border-radius: 2px; }
.changes-cell ins { background: #a7f3d0; color: #064e3b; text-decoration: none; border-radius: 2px; }
.changes-skip { grid-column: 1 / -1; padding: 6px 12px; font-size: 12px; color: var(--pl-text-muted, #5C6370); text-align: center; }
.changes-empty { padding: 56px 20px; text-align: center; color: var(--pl-text-muted, #5C6370); font-size: 14px; }
@media (prefers-reduced-motion: reduce) { .changes-body { scroll-behavior: auto; } }
/* Narrow screens: the header pill fills the width, so sit on the row below it. */
@media (max-width: 899px) {
  .changes-toggle { top: 76px; right: 12px; height: 36px; padding: 0 12px; }
}
@media (max-width: 720px) {
  .changes-head { flex-wrap: wrap; }
  .changes-backdrop { padding: 0; }
  .changes-dialog { border-radius: 0; height: 100%; }
}
@media print { .changes-toggle, .changes-backdrop { display: none; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ChangesView {
  private readonly toggle = el('button', 'changes-toggle');
  private readonly count = el('span', 'changes-count', '0');
  private readonly backdrop = el('div', 'changes-backdrop');
  private readonly body = el('div', 'changes-body');
  private readonly sub = el('div', 'changes-sub');
  private readonly stepper = el('div', 'changes-step');
  private readonly stepLabel = el('span', 'changes-step-label');
  private changedRows: HTMLElement[] = [];
  private stepIndex = -1;
  private baseline: string | null = null;
  private lastAfter = '';
  private stale = true;

  constructor(private readonly options: ChangesViewOptions) {}

  mount(): void {
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.toggle.type = 'button';
    this.toggle.innerHTML = ICON;
    this.toggle.append(el('span', 'changes-label', 'Changes'), this.count);
    this.toggle.setAttribute('aria-haspopup', 'dialog');
    this.toggle.addEventListener('click', () => this.open());

    const dialog = el('div', 'changes-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Changes since you opened this document');
    const head = el('div', 'changes-head');
    const titles = el('div');
    titles.append(el('div', 'changes-title', 'Changes'), this.sub);
    const actions = el('div', 'changes-head-actions');
    const reset = el('button', 'changes-btn', 'Start from here');
    reset.type = 'button';
    reset.title = 'Forget the earlier version and compare against the document as it is now';
    reset.addEventListener('click', () => {
      this.setBaseline(this.current());
      this.refresh();
      this.render();
    });
    const close = el('button', 'changes-btn', 'Close');
    close.type = 'button';
    close.dataset.primary = '';
    close.addEventListener('click', () => this.close());

    const previous = el('button', 'changes-btn');
    previous.type = 'button';
    previous.innerHTML = STEP_UP_ICON;
    previous.setAttribute('aria-label', 'Previous change');
    previous.addEventListener('click', () => this.step(-1));
    const next = el('button', 'changes-btn');
    next.type = 'button';
    next.innerHTML = STEP_DOWN_ICON;
    next.setAttribute('aria-label', 'Next change');
    next.addEventListener('click', () => this.step(1));
    this.stepper.append(previous, this.stepLabel, next);
    this.stepper.hidden = true;

    actions.append(this.stepper, reset, close);
    head.append(titles, actions);
    const cols = el('div', 'changes-cols');
    cols.append(el('div', undefined, 'Before'), el('div', undefined, 'Now'));
    dialog.append(head, cols, this.body);
    this.backdrop.hidden = true;
    this.backdrop.append(dialog);
    this.backdrop.addEventListener('click', (event) => {
      if (event.target === this.backdrop) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.backdrop.hidden) this.close();
    });

    document.body.append(this.toggle, this.backdrop);
    this.refresh();
    window.setInterval(() => {
      if (!document.hidden) this.refresh();
    }, REFRESH_MS);
  }

  private storageKey(): string | null {
    const slug = this.options.getSlug();
    return slug ? `proof-changes-baseline:${slug}` : null;
  }

  private current(): string {
    return stripProofSpans(this.options.getMarkdown());
  }

  private setBaseline(markdown: string): void {
    this.baseline = markdown;
    this.stale = true;
    const key = this.storageKey();
    try {
      if (key) sessionStorage.setItem(key, markdown);
    } catch {
      // Storage full or blocked: the baseline still holds for this page load.
    }
  }

  private refresh(): void {
    const after = this.current();
    if (this.baseline === null) {
      const key = this.storageKey();
      let stored: string | null = null;
      try {
        stored = key ? sessionStorage.getItem(key) : null;
      } catch {
        stored = null;
      }
      // The document arrives over the collab socket a moment after the editor
      // mounts; an empty snapshot is "not loaded yet", not a baseline.
      if (stored !== null) this.baseline = stored;
      else if (after.trim()) this.setBaseline(after);
      else return;
    }
    if (!this.stale && after === this.lastAfter) return;
    this.stale = false;
    this.lastAfter = after;
    const summary = summarize(diffMarkdown(this.baseline!, after));
    const total = summary.added + summary.removed + summary.changed;
    this.count.textContent = String(total);
    this.toggle.dataset.dirty = String(total > 0);
    this.toggle.title = total ? `${total} change${total === 1 ? '' : 's'} since you opened this document` : 'No changes since you opened this document';
    if (!this.backdrop.hidden) this.render();
  }

  private open(): void {
    this.refresh();
    this.render();
    this.backdrop.hidden = false;
    (this.backdrop.querySelector('.changes-btn[data-primary]') as HTMLElement | null)?.focus();
  }

  // Moves a ring to the next or previous changed block and scrolls it into view.
  private step(direction: 1 | -1): void {
    if (!this.changedRows.length) return;
    this.changedRows[this.stepIndex]?.removeAttribute('data-current');
    const from = this.stepIndex < 0 ? (direction === 1 ? -1 : 0) : this.stepIndex;
    this.stepIndex = (from + direction + this.changedRows.length) % this.changedRows.length;
    const row = this.changedRows[this.stepIndex];
    row.dataset.current = 'true';
    row.scrollIntoView({ block: 'center' });
    this.stepLabel.textContent = `${this.stepIndex + 1} of ${this.changedRows.length}`;
  }

  private close(): void {
    this.backdrop.hidden = true;
    this.toggle.focus();
  }

  private render(): void {
    const rows = diffMarkdown(this.baseline ?? '', this.current());
    const summary = summarize(rows);
    const parts = [
      summary.changed ? `${summary.changed} edited` : '',
      summary.added ? `${summary.added} added` : '',
      summary.removed ? `${summary.removed} removed` : '',
    ].filter(Boolean);
    this.sub.textContent = parts.length ? `Since you opened this document: ${parts.join(', ')}` : 'Since you opened this document';
    this.body.replaceChildren();
    this.changedRows = [];
    this.stepIndex = -1;
    const total = summary.changed + summary.added + summary.removed;
    this.stepper.hidden = total < 2;
    this.stepLabel.textContent = `${total} changes`;
    if (!parts.length) {
      this.body.append(el('div', 'changes-empty', 'Nothing has changed yet. Accepted edits, yours or the agent’s, will show up here.'));
      return;
    }
    // Long unchanged stretches collapse; one block of context stays on each side of a change.
    let run: BlockRow[] = [];
    const flushRun = (atEnd: boolean) => {
      if (run.length > COLLAPSE_AFTER) {
        const head = this.body.childElementCount ? run.slice(0, 1) : [];
        const tail = atEnd ? [] : run.slice(-1);
        head.forEach(row => this.body.append(this.renderRow(row)));
        const hidden = run.length - head.length - tail.length;
        const skip = el('div', 'changes-row');
        skip.append(el('div', 'changes-skip', `${hidden} unchanged block${hidden === 1 ? '' : 's'}`));
        this.body.append(skip);
        tail.forEach(row => this.body.append(this.renderRow(row)));
      } else run.forEach(row => this.body.append(this.renderRow(row)));
      run = [];
    };
    for (const row of rows) {
      if (row.kind === 'same') run.push(row);
      else {
        flushRun(false);
        this.body.append(this.renderRow(row));
      }
    }
    flushRun(true);
  }

  private renderRow(row: BlockRow): HTMLElement {
    const node = el('div', 'changes-row');
    node.dataset.kind = row.kind;
    if (row.kind !== 'same') this.changedRows.push(node);
    const cell = (side: 'before' | 'after', tone: string, content: string | WordPart[] | null) => {
      const c = el('div', 'changes-cell');
      c.dataset.side = side;
      c.dataset.tone = content === null ? 'empty' : tone;
      if (typeof content === 'string') c.textContent = content;
      else if (content) {
        for (const part of content) {
          c.append(part.op === 'same' ? document.createTextNode(part.text) : el(part.op === 'removed' ? 'del' : 'ins', undefined, part.text));
        }
      }
      return c;
    };
    if (row.kind === 'same') node.append(cell('before', 'same', row.text), cell('after', 'same', row.text));
    else if (row.kind === 'removed') node.append(cell('before', 'removed', row.text), cell('after', 'removed', null));
    else if (row.kind === 'added') node.append(cell('before', 'added', null), cell('after', 'added', row.text));
    else node.append(cell('before', 'removed', row.before), cell('after', 'added', row.after));
    return node;
  }
}
