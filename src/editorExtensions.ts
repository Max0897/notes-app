import {Extension} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Highlight from '@tiptap/extension-highlight';
import {tableSize} from './editorTable';
import {EditorSearch} from './editorSearch';
import {SlashCommands} from './editorSlash';
import {EditorCodeBlock} from './editorCodeBlock';

// Reuse the same document nodes in personal notes, team notes and history previews.
const EditorTable = Table.extend({
  addKeyboardShortcuts() {
    return {...this.parent?.(), Tab: () => {
      if (!this.editor.isEditable) return false;
      if (this.editor.commands.goToNextCell()) return true;
      if (!this.editor.isActive('table')) return false;
      if (tableSize(this.editor).rows >= 100) return true;
      return this.editor.chain().addRowAfter().goToNextCell().run();
    }};
  },
});
// A table as the last node leaves no caret position below it, so keep an empty paragraph there.
// Remote Yjs transactions are skipped; every client adds it only on its own interaction.
const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('trailingParagraph'),
      appendTransaction: (transactions, _old, state) => {
        if (!this.editor.isEditable || transactions.some(tr => tr.getMeta('y-sync$')?.isChangeOrigin)) return null;
        const last = state.doc.lastChild, paragraph = state.schema.nodes.paragraph;
        if (last?.type.name !== 'table' || !paragraph) return null;
        return state.tr.insert(state.doc.content.size, paragraph.create());
      },
    })];
  },
});
export const documentExtensions = () => [EditorTable.configure({resizable: true, cellMinWidth: 64}), TableRow, TableHeader, TableCell, Highlight, EditorCodeBlock, TrailingParagraph];
export const interactionExtensions = () => [EditorSearch, SlashCommands];
