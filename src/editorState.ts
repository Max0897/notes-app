import {useCallback, useSyncExternalStore} from 'react';
import type {Editor} from '@tiptap/core';

// setEditable emits update without a transaction, including live permission changes.
export function useEditorEditable(editor: Editor | null) {
  const subscribe = useCallback((changed: () => void) => {
    editor?.on('update', changed);
    return () => { editor?.off('update', changed); };
  }, [editor]);
  return useSyncExternalStore(subscribe, () => !!editor?.isEditable, () => false);
}
