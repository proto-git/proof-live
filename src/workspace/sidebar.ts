// The workspace sidebar: the workspace's documents in a drawer on the left,
// with "New" and "Import" for bringing a folder of Markdown files in.
//
// It only appears when the server has the shared workspace turned on
// (PROOF_PUBLIC_WORKSPACE=1, see server/workspace-routes.ts). On any other
// deployment the status call says "disabled" and the editor is left untouched.

export interface WorkspaceDocument {
  slug: string;
  title: string;
  updatedAt: string;
}

export interface WorkspaceSidebarOptions {
  // Base URL of the document server's API, for example "https://host/api".
  getApiBase(): string;
  getCurrentSlug(): string | null;
}

const OPEN_KEY = 'proof-workspace-sidebar-open';
const WIDTH_PX = 272;
const IMPORT_ACCEPT = '.md,.markdown,.mdx,.txt,text/markdown,text/plain';
const MAX_IMPORT_BYTES = 400_000;

const LIST_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h4v14H4zM8 8h12M8 12h12M8 16h8"/></svg>';
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const DOC_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5"/></svg>';

const STYLE = `
.workspace-toggle {
  all: unset;
  box-sizing: border-box;
  position: fixed;
  top: 18px;
  left: 16px;
  z-index: 8900;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-radius: 999px;
  background: #fff;
  color: #374151;
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 4px 18px rgba(12, 14, 20, 0.1), 0 0 0 1px rgba(12, 14, 20, 0.06);
  cursor: pointer;
  transition: background 120ms ease;
}
.workspace-toggle:hover { background: #f6f7f9; }
.workspace-toggle:focus-visible,
.workspace-sidebar button:focus-visible,
.workspace-item:focus-visible { outline: 2px solid #4f7cff; outline-offset: 2px; }
.workspace-open .workspace-toggle { display: none; }

.workspace-sidebar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 8950;
  width: ${WIDTH_PX}px;
  display: flex;
  flex-direction: column;
  background: #fbfbfa;
  border-right: 1px solid rgba(12, 14, 20, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1f2430;
  transform: translateX(-100%);
  transition: transform 180ms ease;
}
.workspace-open .workspace-sidebar { transform: none; }

.workspace-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 12px 10px 18px;
}
.workspace-title { flex: 1; font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
.workspace-count { color: #8a909c; font-weight: 500; margin-left: 6px; }
.workspace-icon-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #6b7280;
  cursor: pointer;
}
.workspace-icon-btn:hover { background: rgba(12, 14, 20, 0.06); color: #1f2430; }

.workspace-actions { display: flex; gap: 8px; padding: 0 14px 12px 14px; }
.workspace-btn {
  all: unset;
  box-sizing: border-box;
  flex: 1;
  height: 32px;
  border-radius: 9px;
  text-align: center;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  background: #fff;
  color: #1f2430;
  box-shadow: 0 0 0 1px rgba(12, 14, 20, 0.1);
}
.workspace-btn:hover { background: #f3f4f6; }
.workspace-btn[data-primary] { background: #16181d; color: #f4f5f7; box-shadow: none; }
.workspace-btn[data-primary]:hover { background: #2a2d35; }
.workspace-btn[disabled] { opacity: 0.55; cursor: default; }

.workspace-list { flex: 1; overflow-y: auto; padding: 2px 8px 16px 8px; }
.workspace-item {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  color: #374151;
}
.workspace-item:hover { background: rgba(12, 14, 20, 0.05); }
.workspace-item[aria-current="page"] { background: rgba(79, 124, 255, 0.12); color: #1b2a57; }
.workspace-item svg { flex-shrink: 0; margin-top: 2px; color: #9aa1ad; }
.workspace-item[aria-current="page"] svg { color: #4f7cff; }
.workspace-item-text { min-width: 0; flex: 1; }
.workspace-item-title {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workspace-item-meta { margin-top: 2px; font-size: 11.5px; color: #8a909c; }
.workspace-empty { padding: 18px 12px; font-size: 13px; line-height: 1.5; color: #6b7280; }
.workspace-note {
  margin: 0 14px 10px 14px;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 12.5px;
  line-height: 1.4;
  background: #eef2ff;
  color: #273a7a;
}
.workspace-note[data-tone="error"] { background: #fdecec; color: #8a1f1f; }
.workspace-note[hidden] { display: none; }
.workspace-drop .workspace-sidebar { box-shadow: inset 0 0 0 2px #4f7cff; }

/* Wide screens: the document moves over. Narrow screens: the drawer floats. */
@media (min-width: 900px) {
  body { transition: padding-left 180ms ease; }
  .workspace-open body { padding-left: ${WIDTH_PX}px; }
  /* The header pill and the voice pill are centred on the viewport; keep them
     centred over the document instead. */
  #share-banner, .voice-dock { transition: margin-left 180ms ease; }
  .workspace-open #share-banner, .workspace-open .voice-dock { margin-left: ${WIDTH_PX / 2}px; }
}
@media (max-width: 899px) {
  .workspace-sidebar { box-shadow: 0 12px 40px rgba(12, 14, 20, 0.25); }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-sidebar, body, #share-banner, .voice-dock { transition: none !important; }
}
@media print { .workspace-sidebar, .workspace-toggle { display: none; } }
`;

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString();
}

function titleFromFilename(name: string): string {
  const words = name.replace(/\.(md|markdown|mdx|txt)$/i, '').replace(/[-_]+/g, ' ').trim();
  // "style-guide.md" reads better in a list as "Style Guide".
  return words.replace(/(^|\s)[a-z]/g, (match) => match.toUpperCase()) || 'Untitled';
}

export class WorkspaceSidebar {
  private readonly root = document.documentElement;
  private readonly toggle = document.createElement('button');
  private readonly panel = document.createElement('nav');
  private readonly count = document.createElement('span');
  private readonly list = document.createElement('div');
  private readonly note = document.createElement('div');
  private readonly newButton = document.createElement('button');
  private readonly importButton = document.createElement('button');
  private readonly fileInput = document.createElement('input');
  private noteTimer: number | null = null;
  private busy = false;

  constructor(private readonly options: WorkspaceSidebarOptions) {}

  async mount(): Promise<void> {
    const status = await fetch(`${this.options.getApiBase()}/workspace/status`)
      .then((response) => (response.ok ? (response.json() as Promise<{ enabled?: boolean }>) : null))
      .catch(() => null);
    if (!status?.enabled) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.toggle.className = 'workspace-toggle';
    this.toggle.type = 'button';
    this.toggle.innerHTML = `${LIST_ICON}<span>Documents</span>`;
    this.toggle.setAttribute('aria-label', 'Show documents');
    this.toggle.addEventListener('click', () => this.setOpen(true));

    this.panel.className = 'workspace-sidebar';
    this.panel.setAttribute('aria-label', 'Documents');

    const head = document.createElement('div');
    head.className = 'workspace-head';
    const title = document.createElement('div');
    title.className = 'workspace-title';
    title.textContent = 'Documents';
    this.count.className = 'workspace-count';
    title.appendChild(this.count);
    const close = document.createElement('button');
    close.className = 'workspace-icon-btn';
    close.type = 'button';
    close.innerHTML = CLOSE_ICON;
    close.title = 'Hide documents';
    close.setAttribute('aria-label', 'Hide documents');
    close.addEventListener('click', () => this.setOpen(false));
    head.append(title, close);

    const actions = document.createElement('div');
    actions.className = 'workspace-actions';
    this.newButton.className = 'workspace-btn';
    this.newButton.type = 'button';
    this.newButton.dataset.primary = '';
    this.newButton.textContent = 'New';
    this.newButton.addEventListener('click', () => void this.createAndOpen());
    this.importButton.className = 'workspace-btn';
    this.importButton.type = 'button';
    this.importButton.textContent = 'Import';
    this.importButton.title = 'Import Markdown files';
    this.importButton.addEventListener('click', () => this.fileInput.click());
    actions.append(this.newButton, this.importButton);

    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.accept = IMPORT_ACCEPT;
    this.fileInput.hidden = true;
    this.fileInput.addEventListener('change', () => {
      const files = Array.from(this.fileInput.files ?? []);
      this.fileInput.value = '';
      void this.importFiles(files);
    });

    this.note.className = 'workspace-note';
    this.note.hidden = true;
    this.note.setAttribute('role', 'status');

    this.list.className = 'workspace-list';

    this.panel.append(head, actions, this.note, this.list, this.fileInput);
    document.body.append(this.toggle, this.panel);

    // Dropping files anywhere on the drawer imports them.
    this.panel.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      this.root.classList.add('workspace-drop');
    });
    this.panel.addEventListener('dragleave', () => this.root.classList.remove('workspace-drop'));
    this.panel.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      this.root.classList.remove('workspace-drop');
      void this.importFiles(Array.from(event.dataTransfer.files));
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen() && window.matchMedia('(max-width: 899px)').matches) this.setOpen(false);
    });

    const stored = localStorage.getItem(OPEN_KEY);
    this.setOpen(stored === null ? window.matchMedia('(min-width: 1100px)').matches : stored === '1', false);
    await this.refresh();
  }

  private isOpen(): boolean {
    return this.root.classList.contains('workspace-open');
  }

  private setOpen(open: boolean, remember = true): void {
    this.root.classList.toggle('workspace-open', open);
    this.panel.inert = !open;
    if (remember) localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    if (open) void this.refresh();
  }

  private async refresh(): Promise<void> {
    const documents = await fetch(`${this.options.getApiBase()}/workspace/documents`)
      .then((response) => (response.ok ? (response.json() as Promise<{ documents: WorkspaceDocument[] }>) : null))
      .then((body) => body?.documents ?? null)
      .catch(() => null);
    if (!documents) {
      this.showNote('Could not load the document list.', 'error');
      return;
    }
    this.render(documents);
  }

  private render(documents: WorkspaceDocument[]): void {
    this.count.textContent = documents.length ? String(documents.length) : '';
    this.list.replaceChildren();
    if (documents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'workspace-empty';
      empty.textContent = 'No documents yet. Create one, or import Markdown files to get started.';
      this.list.appendChild(empty);
      return;
    }
    const current = this.options.getCurrentSlug();
    for (const doc of documents) {
      const item = document.createElement('button');
      item.className = 'workspace-item';
      item.type = 'button';
      if (doc.slug === current) item.setAttribute('aria-current', 'page');
      const text = document.createElement('span');
      text.className = 'workspace-item-text';
      const title = document.createElement('div');
      title.className = 'workspace-item-title';
      title.textContent = doc.title;
      title.title = doc.title;
      const meta = document.createElement('div');
      meta.className = 'workspace-item-meta';
      meta.textContent = doc.slug === current ? 'Open now' : `Edited ${relativeTime(doc.updatedAt)}`;
      text.append(title, meta);
      item.innerHTML = DOC_ICON;
      item.appendChild(text);
      item.addEventListener('click', () => {
        if (doc.slug !== current) void this.open(doc.slug);
      });
      this.list.appendChild(item);
    }
  }

  private async open(slug: string): Promise<void> {
    const url = await fetch(`${this.options.getApiBase()}/workspace/documents/${encodeURIComponent(slug)}/open`, { method: 'POST' })
      .then((response) => (response.ok ? (response.json() as Promise<{ url?: string }>) : null))
      .then((body) => body?.url ?? null)
      .catch(() => null);
    if (!url) {
      this.showNote('Could not open that document.', 'error');
      return;
    }
    window.location.assign(url);
  }

  private async create(title: string, markdown: string): Promise<{ url: string } | null> {
    return fetch(`${this.options.getApiBase()}/workspace/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, markdown }),
    })
      .then((response) => (response.ok ? (response.json() as Promise<{ url: string }>) : null))
      .catch(() => null);
  }

  private async createAndOpen(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    const created = await this.create('Untitled', '');
    this.setBusy(false);
    if (!created) {
      this.showNote('Could not create a document.', 'error');
      return;
    }
    window.location.assign(created.url);
  }

  private async importFiles(files: File[]): Promise<void> {
    if (this.busy || files.length === 0) return;
    this.setBusy(true);
    let imported = 0;
    const skipped: string[] = [];
    for (const file of files) {
      if (file.size > MAX_IMPORT_BYTES || !/\.(md|markdown|mdx|txt)$/i.test(file.name)) {
        skipped.push(file.name);
        continue;
      }
      this.showNote(`Importing ${file.name}`);
      const markdown = await file.text().catch(() => null);
      // A document's own top heading is a better title than its filename.
      const title = markdown !== null && /^\s{0,3}#\s+\S/m.test(markdown) ? '' : titleFromFilename(file.name);
      if (markdown === null || !(await this.create(title, markdown))) skipped.push(file.name);
      else imported++;
    }
    this.setBusy(false);
    await this.refresh();
    const summary = `Imported ${imported} document${imported === 1 ? '' : 's'}.`;
    if (skipped.length) this.showNote(`${summary} Skipped: ${skipped.join(', ')}.`, 'error');
    else this.showNote(summary);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.newButton.disabled = busy;
    this.importButton.disabled = busy;
  }

  private showNote(text: string, tone?: 'error'): void {
    this.note.hidden = false;
    this.note.textContent = text;
    if (tone) this.note.dataset.tone = tone;
    else delete this.note.dataset.tone;
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.note.hidden = true;
    }, tone ? 8000 : 4000);
  }
}
