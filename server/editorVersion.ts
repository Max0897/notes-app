// Bump when a document gains nodes or marks that older clients would discard.
export const EDITOR_CAPABILITY = 'notes-editor-v3';

export function needsCurrentEditor(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as {type?: string; content?: unknown[]; marks?: unknown[]};
  return node.type === 'table' || node.type === 'highlight'
    || !!node.content?.some(needsCurrentEditor) || !!node.marks?.some(needsCurrentEditor);
}
