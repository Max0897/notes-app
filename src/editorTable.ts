import type {Editor} from '@tiptap/core';
import {TableMap} from '@tiptap/pm/tables';

export function tableSize(editor: Editor) {
  const {$from} = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'table') return {rows: node.childCount, columns: TableMap.get(node).width};
  }
  return {rows: 0, columns: 0};
}
export const tableActions = [
  {key: 'row-before', label: '上方插入行', dimension: 'rows', run: (editor: Editor) => editor.chain().focus().addRowBefore().run()},
  {key: 'row-after', label: '下方插入行', dimension: 'rows', run: (editor: Editor) => editor.chain().focus().addRowAfter().run()},
  {key: 'column-before', label: '左侧插入列', dimension: 'columns', run: (editor: Editor) => editor.chain().focus().addColumnBefore().run()},
  {key: 'column-after', label: '右侧插入列', dimension: 'columns', run: (editor: Editor) => editor.chain().focus().addColumnAfter().run()},
  {key: 'header', label: '切换表头', run: (editor: Editor) => editor.chain().focus().toggleHeaderRow().run()},
  {key: 'delete-row', label: '删除当前行', run: (editor: Editor) => editor.chain().focus().deleteRow().run()},
  {key: 'delete-column', label: '删除当前列', run: (editor: Editor) => editor.chain().focus().deleteColumn().run()},
  {key: 'delete-table', label: '删除表格', run: (editor: Editor) => editor.chain().focus().deleteTable().run()},
] as const;
export function tableActionDisabled(editor: Editor, action: typeof tableActions[number]) {
  if (!editor.isEditable || !editor.isActive('table')) return true;
  return 'dimension' in action && tableSize(editor)[action.dimension] >= 100;
}
