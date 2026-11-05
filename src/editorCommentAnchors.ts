import {Extension, type Editor} from '@tiptap/core';
import type {EditorState} from '@tiptap/pm/state';
import {Plugin} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';
import * as Y from 'yjs';
import {absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey} from 'y-prosemirror';
import type {CommentAnchor} from './api';

// 评论锚点用 Yjs 相对位置记录选中文字的起止，随协作编辑一起移动，不修改正文。
// 文字被删除后位置会塌缩，此时认为「原文已不存在」，评论仍保留引用的文字。
export type AnchoredComment = {id: string; anchor: CommentAnchor};
type SyncState = {doc: Y.Doc; type: Y.XmlFragment; binding?: {mapping: Map<unknown, unknown>}};
const syncState = (state: EditorState) => ySyncPluginKey.getState(state) as SyncState | undefined;
const MAX_DECORATED = 100;

export function captureAnchor(editor: Editor): CommentAnchor | null {
  const {from, to, empty} = editor.state.selection, sync = syncState(editor.state);
  if (empty || !sync?.binding) return null;
  const quote = Array.from(editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
  if (!quote) return null;
  const relative = (pos: number) => Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, sync.type, sync.binding!.mapping as never));
  return {from: relative(from), to: relative(to), quote};
}

// 解析为当前文档中的位置；位置失效、范围为空或超出文档时返回 null。
export function resolveAnchor(state: EditorState, anchor: CommentAnchor): {from: number; to: number} | null {
  const sync = syncState(state);
  if (!sync?.binding) return null;
  try {
    const mapping = sync.binding.mapping as never;
    const from = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(anchor.from), mapping);
    const to = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromJSON(anchor.to), mapping);
    return from === null || to === null || to <= from || to > state.doc.content.size ? null : {from, to};
  } catch { return null; }
}

// 引用位置当前对应的正文文字（评论卡片据此同步显示）；位置已失效时返回 null。
export function anchorText(state: EditorState, anchor: CommentAnchor): string | null {
  const range = resolveAnchor(state, anchor);
  if (!range) return null;
  const chars = Array.from(state.doc.textBetween(range.from, range.to, ' ').replace(/\s+/g, ' ').trim());
  return chars.length ? chars.slice(0, 200).join('') + (chars.length > 200 ? '…' : '') : null;
}

type Storage = {anchors: AnchoredComment[]; activeId: string | null; onOpen: ((id: string) => void) | null; timer?: ReturnType<typeof setTimeout>};
export const CommentAnchors = Extension.create<unknown, Storage>({
  name: 'commentAnchors',
  addStorage: () => ({anchors: [], activeId: null, onOpen: null}),
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [new Plugin({
      // 正文变化后（稍作合并）通知评论面板，让卡片上的引用文字跟着更新。
      view: () => ({
        update: (view, previous) => {
          if (!storage.anchors.length || view.state.doc.eq(previous.doc)) return;
          clearTimeout(storage.timer);
          storage.timer = setTimeout(() => window.dispatchEvent(new CustomEvent('note-anchors:changed')), 300);
        },
        destroy: () => clearTimeout(storage.timer),
      }),
      props: {
        decorations: state => {
          const decorations: Decoration[] = [];
          for (const item of storage.anchors.slice(0, MAX_DECORATED)) {
            const range = resolveAnchor(state, item.anchor);
            if (range) decorations.push(Decoration.inline(range.from, range.to, {class: 'comment-anchor' + (item.id === storage.activeId ? ' is-active' : ''), 'data-comment-id': item.id}));
          }
          return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
        },
        // 点击带评论的文字时打开对应评论，不拦截光标定位和编辑。
        handleClick: (view, pos) => {
          const hit = storage.anchors.slice(0, MAX_DECORATED).find(item => { const range = resolveAnchor(view.state, item.anchor); return range && pos >= range.from && pos <= range.to; });
          if (hit) storage.onOpen?.(hit.id);
          return false;
        },
      },
    })];
  },
});

function redraw(editor: Editor) { if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('commentAnchors', true)); }
export function setCommentAnchors(editor: Editor, anchors: AnchoredComment[]) { (editor.storage.commentAnchors as Storage).anchors = anchors; redraw(editor); }
export function setCommentAnchorOpener(editor: Editor, onOpen: ((id: string) => void) | null) { (editor.storage.commentAnchors as Storage).onOpen = onOpen; }

let activeTimer: ReturnType<typeof setTimeout> | undefined;
export function setActiveCommentAnchor(editor: Editor, id: string | null) {
  (editor.storage.commentAnchors as Storage).activeId = id; redraw(editor);
  clearTimeout(activeTimer);
  if (id) activeTimer = setTimeout(() => { if (!editor.isDestroyed) setActiveCommentAnchor(editor, null); }, 2500);
}
// 把引用的文字滚动到编辑区中间并短暂高亮；位置已失效时返回 false。
export function revealCommentAnchor(editor: Editor, id: string, anchor: CommentAnchor): boolean {
  const range = resolveAnchor(editor.state, anchor);
  if (!range) return false;
  const {node} = editor.view.domAtPos(range.from), element = node.nodeType === 1 ? node as HTMLElement : node.parentElement;
  element?.scrollIntoView({block: 'center', behavior: 'smooth'});
  setActiveCommentAnchor(editor, id);
  return true;
}
