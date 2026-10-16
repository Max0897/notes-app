import Image from '@tiptap/extension-image';
import {Extension, type Editor} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';
import {closeHistory} from '@tiptap/pm/history';
import {yUndoPluginKey} from 'y-prosemirror';
import {Message} from '@arco-design/web-react';

const imagePath = /^\/api\/images\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const validWidth = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 80 && value <= 4096;
export const EditorImage = Image.extend({
  addAttributes() {
    return {...this.parent?.(), imageId: {
      default: null,
      parseHTML: element => imagePath.exec(element.getAttribute('src') ?? '')?.[1] ?? null,
      renderHTML: attributes => ({'data-image-id': attributes.imageId}),
    }, width: {
      default: null,
      parseHTML: element => { const width = Number(element.getAttribute('width')); return validWidth(width) ? width : null; },
      renderHTML: attributes => validWidth(attributes.width) ? {width: attributes.width} : {},
    }};
  },
  parseHTML() { return [{tag: 'img[src]', getAttrs: element => imagePath.test((element as HTMLElement).getAttribute('src') ?? '') ? null : false}]; },
  // External URLs and data URLs must go through the upload endpoint.
  addInputRules() { return []; },
  addNodeView() {
    return ({node, editor, getPos}) => {
      const dom = document.createElement('figure'), image = document.createElement('img'), handle = document.createElement('button');
      dom.className = 'editor-image'; dom.contentEditable = 'false';
      image.loading = 'lazy'; image.decoding = 'async';
      handle.type = 'button'; handle.className = 'image-resize-handle'; handle.setAttribute('aria-label', '调整图片大小');
      dom.append(image, handle);
      let drag: {pointerId: number; x: number; y: number; width: number; ratio: number; max: number; next: number | null} | null = null;
      const showWidth = (width: unknown) => {
        dom.style.width = validWidth(width) ? `${width}px` : '';
        image.style.width = validWidth(width) ? '100%' : '';
      };
      const commit = (width: number) => {
        if (!editor.isEditable || editor.isDestroyed) return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const current = editor.state.doc.nodeAt(pos);
        if (current?.type !== node.type || current.attrs.imageId !== node.attrs.imageId || current.attrs.width === width) return;
        // One undo step per gesture, for both personal and Yjs editors.
        const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
        undo?.stopCapturing();
        editor.view.dispatch(closeHistory(editor.state.tr.setNodeMarkup(pos, undefined, {...current.attrs, width})));
        undo?.stopCapturing();
        editor.view.dispatch(closeHistory(editor.state.tr));
      };
      const finish = (save: boolean) => {
        if (!drag) return;
        const {next, pointerId} = drag; drag = null;
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancelPointer); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape);
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        dom.classList.remove('is-resizing'); showWidth(node.attrs.width);
        if (save && next !== null) commit(next);
      };
      const move = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!editor.isEditable) { finish(false); return; }
        event.preventDefault();
        const dx = event.clientX - drag.x, dy = (event.clientY - drag.y) * drag.ratio;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 2 && drag.next === null) return;
        drag.next = Math.round(Math.max(80, Math.min(drag.max, drag.width + (Math.abs(dx) >= Math.abs(dy) ? dx : dy))));
        showWidth(drag.next);
      };
      const up = (event: PointerEvent) => { if (event.pointerId === drag?.pointerId) { event.preventDefault(); finish(true); } };
      const cancelPointer = (event: PointerEvent) => { if (event.pointerId === drag?.pointerId) finish(false); };
      const cancel = () => finish(false);
      const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } };
      const maxWidth = () => {
        const parent = dom.parentElement;
        const style = parent ? getComputedStyle(parent) : null;
        const width = parent ? parent.clientWidth - parseFloat(style?.paddingLeft || '0') - parseFloat(style?.paddingRight || '0') : 0;
        return Math.max(80, Math.min(4096, width || 4096));
      };
      const start = (event: PointerEvent) => {
        if (!editor.isEditable || event.button !== 0 || drag) return;
        const rect = image.getBoundingClientRect();
        if (!rect.width) return;
        event.preventDefault(); event.stopPropagation();
        drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: rect.width, ratio: rect.height ? rect.width / rect.height : 1, max: maxWidth(), next: null};
        dom.classList.add('is-resizing');
        handle.setPointerCapture?.(event.pointerId);
        window.addEventListener('pointermove', move, {passive: false}); window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancelPointer); window.addEventListener('blur', cancel); window.addEventListener('keydown', escape);
      };
      const keyboardResize = (event: KeyboardEvent) => {
        if (!editor.isEditable || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const width = image.getBoundingClientRect().width;
        if (width) commit(Math.round(Math.max(80, Math.min(maxWidth(), width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10)))));
      };
      const editableChanged = () => { handle.hidden = !editor.isEditable; handle.disabled = !editor.isEditable; if (!editor.isEditable) finish(false); };
      const update = (next: typeof node) => {
        if (next.type !== node.type) return false;
        if (drag && (next.attrs.width !== node.attrs.width || next.attrs.imageId !== node.attrs.imageId)) finish(false);
        node = next;
        const src = imagePath.test(node.attrs.src ?? '') ? node.attrs.src : '';
        if (image.getAttribute('src') !== src) image.setAttribute('src', src);
        image.alt = node.attrs.alt || '正文图片';
        if (!drag) showWidth(node.attrs.width);
        editableChanged(); return true;
      };
      update(node);
      const preview = () => {
        if (imagePath.test(node.attrs.src ?? '')) window.dispatchEvent(new CustomEvent('note-image:preview', {detail: {src: node.attrs.src, alt: image.alt}}));
      };
      image.addEventListener('click', preview);
      handle.addEventListener('pointerdown', start); handle.addEventListener('keydown', keyboardResize);
      handle.addEventListener('lostpointercapture', cancel);
      editor.on('update', editableChanged);
      return {dom, update, selectNode: () => dom.classList.add('ProseMirror-selectednode'), deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
        stopEvent: event => event.target instanceof Node && handle.contains(event.target), ignoreMutation: () => true,
        destroy: () => { finish(false); editor.off('update', editableChanged); image.removeEventListener('click', preview); handle.removeEventListener('pointerdown', start); handle.removeEventListener('keydown', keyboardResize); handle.removeEventListener('lostpointercapture', cancel); }};
    };
  },
});

type Job = {id: string; file: File; dom: HTMLElement; label: HTMLElement; progress: HTMLProgressElement; retry: HTMLButtonElement; cancel: HTMLButtonElement; status: 'waiting' | 'uploading' | 'failed'; xhr?: XMLHttpRequest; done?: Promise<void>};
type UploadStorage = {jobs: Map<string, Job>; active: number; sequence: number; destroyed: boolean};
const uploadsKey = new PluginKey<DecorationSet>('image-uploads');
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageUploads: {uploadImages: (files: File[], position?: number) => ReturnType};
  }
}
function storage(editor: Editor | null): UploadStorage | undefined { return editor?.storage.imageUploads; }
export function hasImageUploads(editor: Editor | null) { return !!storage(editor)?.jobs.size; }
export async function finishImageUploads(editor: Editor | null) {
  const state = storage(editor);
  if (!state) return true;
  while ([...state.jobs.values()].some(job => job.status !== 'failed')) {
    await Promise.all([...state.jobs.values()].map(job => job.done).filter(Boolean));
    if (state.destroyed) return false;
  }
  if (state.jobs.size) Message.warning('有图片上传失败，请重试或取消后再继续');
  return !state.jobs.size;
}
export function chooseImages(editor: Editor | null) {
  if (!editor?.isEditable) return;
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp'; input.multiple = true;
  input.addEventListener('change', () => {
    if (!editor.isDestroyed && editor.isEditable) editor.commands.uploadImages(Array.from(input.files ?? []));
    input.remove();
  }, {once: true});
  input.click();
}

export const ImageUploads = Extension.create<{path: string}, UploadStorage>({
  name: 'imageUploads',
  addOptions() { return {path: ''}; },
  addStorage() { return {jobs: new Map(), active: 0, sequence: 0, destroyed: false}; },
  addCommands() {
    return {uploadImages: (files, position) => () => {
      const editor = this.editor, state = this.storage;
      if (!editor.isEditable || state.destroyed || !this.options.path) return false;
      if (files.length > 10 || state.jobs.size + files.length > 10) { Message.warning('一次最多上传 10 张图片'); return false; }
      const remove = (job: Job) => {
        state.jobs.delete(job.id);
        if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, {remove: job.id}).setMeta('addToHistory', false));
      };
      const start = (job: Job) => {
        if (state.destroyed || !state.jobs.has(job.id)) return;
        if (!editor.isEditable) { remove(job); return; }
        state.active++; job.status = 'uploading'; job.label.textContent = '正在上传图片'; job.progress.value = 0; job.retry.hidden = true;
        job.done = new Promise<void>(resolve => {
          const xhr = new XMLHttpRequest(); job.xhr = xhr;
          xhr.open('POST', this.options.path); xhr.withCredentials = true; xhr.timeout = 120_000;
          xhr.upload.onprogress = event => { if (event.lengthComputable) { job.progress.value = event.loaded / event.total * 100; job.label.textContent = event.loaded === event.total ? '正在处理图片' : `正在上传图片 ${Math.round(job.progress.value)}%`; } };
          let finished = false;
          const complete = (error?: string) => {
            if (finished) return; finished = true; state.active--;
            window.dispatchEvent(new Event('storage:refresh'));
            if (state.jobs.has(job.id) && !state.destroyed) {
              if (error) { job.status = 'failed'; job.label.textContent = error; job.retry.hidden = false; }
              else remove(job);
            }
            resolve(); pump();
          };
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText);
              if (xhr.status !== 201) { complete(data.error || '图片上传失败'); return; }
              const decorations = uploadsKey.getState(editor.state), placeholder = decorations?.find(undefined, undefined, spec => spec.id === job.id)[0];
              if (placeholder && !editor.isDestroyed && editor.isEditable && imagePath.test(data.image?.src ?? '') && imagePath.exec(data.image.src)?.[1] === data.image.id) {
                const inserted = editor.chain().command(({tr}) => { tr.setMeta(uploadsKey, {inserting: job.id}); return true; })
                  .insertContentAt(placeholder.from, {type: 'image', attrs: {imageId: data.image.id, src: data.image.src, alt: job.file.name.slice(0, 200)}}, {updateSelection: false}).run();
                if (!inserted) { complete('当前位置无法插入图片'); return; }
              }
              complete();
            } catch { complete('图片上传失败，请重试'); }
          };
          xhr.onerror = () => complete('网络异常，点击重试'); xhr.ontimeout = () => complete('上传超时，点击重试'); xhr.onabort = () => complete();
          const body = new FormData(); body.append('file', job.file); xhr.send(body);
        });
      };
      const pump = () => {
        for (const job of state.jobs.values()) {
          if (state.active >= 2 || state.destroyed) break;
          if (job.status === 'waiting') start(job);
        }
      };
      for (const file of files) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { Message.warning('仅支持 JPG、PNG、WebP 图片'); continue; }
        if (!file.size || file.size > 10 * 1024 * 1024) { Message.warning('图片大小须在 10 MB 以内'); continue; }
        const dom = document.createElement('span'), label = document.createElement('span'), progress = document.createElement('progress');
        const retry = document.createElement('button'), cancel = document.createElement('button');
        dom.className = 'image-upload'; dom.contentEditable = 'false'; dom.setAttribute('role', 'status');
        label.textContent = '等待上传图片'; progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', '图片上传进度');
        retry.type = cancel.type = 'button'; retry.textContent = '重试'; cancel.textContent = '取消'; retry.hidden = true;
        const job: Job = {id: crypto.randomUUID(), file, dom, label, progress, retry, cancel, status: 'waiting'};
        retry.addEventListener('click', event => { event.preventDefault(); if (job.status === 'failed') { job.status = 'waiting'; pump(); } });
        cancel.addEventListener('click', event => { event.preventDefault(); remove(job); job.xhr?.abort(); pump(); });
        dom.append(label, progress, retry, cancel); state.jobs.set(job.id, job);
        editor.view.dispatch(editor.state.tr.setMeta(uploadsKey, {add: {id: job.id, order: state.sequence++, pos: position ?? editor.state.selection.from, dom}}).setMeta('addToHistory', false));
      }
      pump(); return true;
    }};
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin<DecorationSet>({key: uploadsKey,
      state: {init: () => DecorationSet.empty, apply: (transaction, previous) => {
        let next = previous.map(transaction.mapping, transaction.doc);
        const meta = transaction.getMeta(uploadsKey);
        if (meta?.inserting) {
          // Inserting a block image can replace an empty paragraph. Keep its
          // sibling upload widgets and preserve file order even if requests
          // finish out of order, without moving the user's current selection.
          const completed = previous.find(undefined, undefined, spec => spec.id === meta.inserting)[0];
          if (completed) next = DecorationSet.create(transaction.doc, previous.find().filter(widget => widget.spec.id !== meta.inserting).map(widget => {
            const before = widget.from === completed.from && widget.spec.order < completed.spec.order;
            return Decoration.widget(transaction.mapping.map(widget.from, before ? -1 : 1), widget.spec.dom, widget.spec);
          }));
        }
        if (meta?.remove) next = next.remove(next.find(undefined, undefined, spec => spec.id === meta.remove));
        if (meta?.add) next = next.add(transaction.doc, [Decoration.widget(meta.add.pos, meta.add.dom, {id: meta.add.id, order: meta.add.order, dom: meta.add.dom, side: -1})]);
        return next;
      }},
      props: {decorations: state => uploadsKey.getState(state),
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!files.length || !editor.isEditable) return false;
          event.preventDefault(); editor.commands.uploadImages(files); return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (moved || !files.length || !editor.isEditable) return false;
          event.preventDefault(); editor.commands.uploadImages(files, view.posAtCoords({left: event.clientX, top: event.clientY})?.pos); return true;
        },
      },
    })];
  },
  onDestroy() { this.storage.destroyed = true; for (const job of this.storage.jobs.values()) job.xhr?.abort(); this.storage.jobs.clear(); },
});
