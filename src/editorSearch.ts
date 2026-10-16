import {Extension, type Editor} from '@tiptap/core';
import {Fragment, type Node} from '@tiptap/pm/model';
import {Plugin, PluginKey, TextSelection} from '@tiptap/pm/state';
import {Decoration, DecorationSet} from '@tiptap/pm/view';
import {closeHistory} from '@tiptap/pm/history';
import {yUndoPluginKey} from 'y-prosemirror';

export type EditorAction = 'find' | 'outline' | 'focus';
export function editorAction(editor: Editor | null, action: EditorAction) {
  if (editor && !editor.isDestroyed) editor.view.dom.dispatchEvent(new CustomEvent('editor:action', {detail: action}));
}
export type Match = {from: number; to: number};
export type SearchState = {term: string; sensitive: boolean; matches: Match[]; index: number};
export const searchKey = new PluginKey<SearchState>('editorSearch');
const empty: SearchState = {term: '', sensitive: false, matches: [], index: 0};

export function findMatches(doc: Node, term: string, sensitive = false): Match[] {
  if (!term) return [];
  const expression = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), sensitive ? 'gu' : 'giu');
  const matches: Match[] = [];
  doc.descendants((node, position) => {
    if (!node.isTextblock) return;
    // Inline leaves retain their document offsets and cannot join separate words.
    const text = node.textBetween(0, node.content.size, '\ufffc', '\ufffc');
    for (const match of text.matchAll(expression)) matches.push({from: position + 1 + match.index, to: position + 1 + match.index + match[0].length});
    return false;
  });
  return matches;
}
export function searchState(editor: Editor): SearchState { return searchKey.getState(editor.state) ?? empty; }
export function setSearch(editor: Editor, term: string, sensitive: boolean) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, {term: term.slice(0, 500), sensitive, index: 0}));
}
export function selectMatch(editor: Editor, index: number) {
  const search = searchState(editor);
  if (!search.matches.length) return;
  index = (index + search.matches.length) % search.matches.length;
  const match = search.matches[index];
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, {index}).setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView());
}
export function replaceMatch(editor: Editor, replacement: string, all = false): number {
  if (!editor.isEditable || replacement.length > 10_000) return 0;
  const search = searchState(editor), matches = all ? search.matches : search.matches.slice(search.index, search.index + 1);
  if (!matches.length) return 0;
  if (editor.state.doc.textContent.length + matches.reduce((total, match) => total + replacement.length - (match.to - match.from), 0) > 200_000) return 0;
  // One transaction preserves undo and maps changes atomically for collaboration.
  const undo = yUndoPluginKey.getState(editor.state)?.undoManager;
  undo?.stopCapturing();
  const transaction = closeHistory(editor.state.tr);
  const original = editor.state.doc, blocks = new Map<number, Match[]>();
  for (const match of matches) {
    const block = original.resolve(match.from).start();
    const group = blocks.get(block) ?? [];
    group.push(match); blocks.set(block, group);
  }
  // Replace each text block once, avoiding thousands of steps for a common letter.
  for (const group of [...blocks.values()].reverse()) {
    const nodes: Node[] = []; let cursor = group[0].from;
    for (const match of group) {
      original.slice(cursor, match.from).content.forEach(node => nodes.push(node));
      const position = original.resolve(match.from), marks = position.nodeAfter?.marks ?? position.marks();
      if (replacement) nodes.push(editor.schema.text(replacement, marks));
      cursor = match.to;
    }
    transaction.replaceWith(group[0].from, group.at(-1)!.to, Fragment.fromArray(nodes));
  }
  const nextMatches = findMatches(transaction.doc, search.term, search.sensitive);
  const next = all ? 0 : nextMatches.findIndex(match => match.from >= matches[0].from + replacement.length);
  transaction.setMeta(searchKey, {index: Math.max(0, next)});
  editor.view.dispatch(transaction);
  undo?.stopCapturing();
  editor.view.dispatch(closeHistory(editor.state.tr));
  return matches.length;
}

export const EditorSearch = Extension.create({
  name: 'editorSearch',
  addKeyboardShortcuts() {
    return {'Mod-f': () => { editorAction(this.editor, 'find'); return true; }};
  },
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => empty,
        apply(transaction, previous) {
          const update = transaction.getMeta(searchKey);
          if (!update && !transaction.docChanged) return previous;
          const next = {...previous, ...update};
          next.matches = findMatches(transaction.doc, next.term, next.sensitive);
          next.index = Math.min(Math.max(0, next.index), Math.max(0, next.matches.length - 1));
          return next;
        },
      },
      props: {
        decorations(state) {
          const search = searchKey.getState(state)!;
          // Bound visual work for a single-character query in a very long note.
          const visible = new Set(search.matches.slice(0, 2000));
          if (search.matches[search.index]) visible.add(search.matches[search.index]);
          return DecorationSet.create(state.doc, [...visible].map(match => Decoration.inline(match.from, match.to, {class: match === search.matches[search.index] ? 'editor-find-match is-current' : 'editor-find-match'})));
        },
      },
    })];
  },
});
