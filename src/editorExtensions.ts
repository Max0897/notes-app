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
export const documentExtensions = () => [EditorTable.configure({resizable: true, cellMinWidth: 64}), TableRow, TableHeader, TableCell, Highlight, EditorCodeBlock];
export const interactionExtensions = () => [EditorSearch, SlashCommands];
