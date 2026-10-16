import {Extension, type Editor} from '@tiptap/core';
import {Plugin, PluginKey, type EditorState} from '@tiptap/pm/state';
import type {LucideIcon} from 'lucide-react';
import {Code, Heading1, Heading2, Heading3, ImagePlus, List, ListChecks, ListOrdered, Minus, Quote, Table2, Type} from 'lucide-react';
import {chooseImages} from './editorImages';

export type InsertCommand = {key: string; label: string; keywords: string; Icon: LucideIcon; run: (editor: Editor) => void};
export const insertCommands: InsertCommand[] = [
  {key: 'paragraph', label: '正文', keywords: 'text p zhengwen', Icon: Type, run: editor => { editor.chain().focus().setParagraph().run(); }},
  ...([1, 2, 3] as const).map((level, index) => ({key: 'h' + level, label: level + ' 级标题', keywords: 'heading biaoti h' + level, Icon: [Heading1, Heading2, Heading3][index], run: (editor: Editor) => { editor.chain().focus().setHeading({level}).run(); }})),
  {key: 'bullet', label: '无序列表', keywords: 'list unordered wuxu liebiao', Icon: List, run: editor => { editor.chain().focus().toggleBulletList().run(); }},
  {key: 'ordered', label: '有序列表', keywords: 'ordered list youxu liebiao', Icon: ListOrdered, run: editor => { editor.chain().focus().toggleOrderedList().run(); }},
  {key: 'tasks', label: '待办清单', keywords: 'todo task daiban qingdan', Icon: ListChecks, run: editor => { editor.chain().focus().toggleTaskList().run(); }},
  {key: 'table', label: '表格', keywords: 'table biaoge', Icon: Table2, run: editor => { editor.chain().focus().insertTable({rows: 3, cols: 3, withHeaderRow: true}).run(); }},
  {key: 'image', label: '图片', keywords: 'image photo tupian', Icon: ImagePlus, run: chooseImages},
  {key: 'quote', label: '引用', keywords: 'quote yinyong', Icon: Quote, run: editor => { editor.chain().focus().toggleBlockquote().run(); }},
  {key: 'code', label: '代码块', keywords: 'code daima', Icon: Code, run: editor => { editor.chain().focus().toggleCodeBlock().run(); }},
  {key: 'rule', label: '分割线', keywords: 'line divider fengexian', Icon: Minus, run: editor => { editor.chain().focus().setHorizontalRule().run(); }},
];
export type SlashState = {from: number; to: number; query: string; index: number} | null;
export const slashKey = new PluginKey<SlashState>('editorSlash');
export const filteredCommands = (query: string) => insertCommands.filter(command => (command.label + ' ' + command.keywords).toLowerCase().includes(query.toLowerCase()));
function matchSlash(state: EditorState): SlashState {
  const {$from, empty} = state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph') return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
  const match = /^\/([^\s/]{0,30})$/.exec(before);
  return match ? {from: $from.start(), to: $from.pos, query: match[1], index: 0} : null;
}
export function runInsert(editor: Editor, command: InsertCommand, slash = slashKey.getState(editor.state)) {
  if (!editor.isEditable || editor.isDestroyed) return;
  if (slash) editor.chain().focus().deleteRange({from: slash.from, to: slash.to}).run();
  editor.view.dispatch(editor.state.tr.setMeta(slashKey, {close: true}));
  command.run(editor);
}
export const SlashCommands = Extension.create({
  name: 'slashCommands',
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin<SlashState>({
      key: slashKey,
      state: {
        init: () => null,
        apply(transaction, previous, _old, next) {
          const meta = transaction.getMeta(slashKey);
          if (meta?.close) return null;
          if (meta?.index !== undefined && previous) return {...previous, index: meta.index};
          if (!transaction.docChanged && !transaction.selectionSet) return previous;
          const match = matchSlash(next);
          if (match && previous?.from === match.from && previous.query === match.query) match.index = previous.index;
          return match;
        },
      },
      props: {
        handleKeyDown(view, event) {
          const state = slashKey.getState(view.state);
          if (!state || !editor.isEditable || view.composing || event.isComposing || event.keyCode === 229) return false;
          const options = filteredCommands(state.query);
          if (event.key === 'Escape') { view.dispatch(view.state.tr.setMeta(slashKey, {close: true})); return true; }
          if (options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            view.dispatch(view.state.tr.setMeta(slashKey, {index: (state.index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length})); return true;
          }
          if (event.key === 'Enter' && options.length) { runInsert(editor, options[Math.min(state.index, options.length - 1)]); return true; }
          return false;
        },
      },
    })];
  },
});
