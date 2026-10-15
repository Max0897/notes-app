import {forwardRef,lazy,Suspense,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {Alert,Button,Message,Space,Tag,Typography} from '@arco-design/web-react';
import {Check} from 'lucide-react';
import {useEditor,EditorContent} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {EditorLink,openEditorLink} from './editorLinks';
import {api,ApiError,type Note,type EditorBridge} from './api';
import type {User} from './api';
import {EditorTools} from './EditorTools';
const TeamNoteEditor=lazy(()=>import('./TeamNoteEditor').then(module=>({default:module.TeamNoteEditor})));
const {Text,Paragraph}=Typography;

// 结构化比较，忽略对象键顺序差异（数据库里存的 JSON 与 Tiptap 重新序列化的键序可能不同）
function canon(v:any):string{
  if(Array.isArray(v))return '['+v.map(canon).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
  return JSON.stringify(v);
}

const SavedNoteEditor=forwardRef<EditorBridge,{note:Note;onSave:(n:Note)=>void;readOnly?:boolean;teamId?:string|null;activeEditors?:string[]}>(function SavedNoteEditor({note,onSave,readOnly=false,teamId,activeEditors=[]},bridge){
const noteApi=(path:string,method='GET',body?:any)=>api((teamId?'/teams/'+teamId:'')+path,method,body);
const [title,setTitle]=useState(note.title),[status,setStatus]=useState('已保存'),[conflict,setConflict]=useState<Note|null>(null);
const latest=useRef(note),dirty=useRef(false),timer=useRef<ReturnType<typeof setTimeout>>(),revision=useRef(0),pending=useRef<Promise<boolean>|null>(null);
// 最近一次成功入库的正文，用于判断「这次变更是否真的改了内容」
const savedContent=useRef(canon(note.content));
const conflictRef=useRef<Note|null>(null);
const editor=useEditor({extensions:[StarterKit,TaskList,TaskItem.configure({nested:true}),EditorLink],editorProps:{handleDOMEvents:{click:(_view,event)=>openEditorLink(event)}},content:note.content,editable:!note.deletedAt&&!readOnly,onUpdate:({editor,transaction})=>{
  if(!transaction.docChanged)return;
  // Tiptap 在聚焦、选区变化等情况下也会触发 update，此时文档其实没变。
  // 若一律标脏，单纯「点开一篇笔记」就会保存一次并刷新修改时间，笔记随即跳到列表最前。
  if(canon(editor.getJSON())===savedContent.current)return;
  changed();
}});
const titleRef=useRef(title);
function changed(){dirty.current=true;revision.current++;setStatus('尚未保存');clearTimeout(timer.current);timer.current=setTimeout(()=>void flush(),700);}
async function flush():Promise<boolean>{clearTimeout(timer.current);if(pending.current){const ok=await pending.current;if(!ok)return false;if(dirty.current&&!conflictRef.current)return flush();return !dirty.current;}if(!dirty.current)return true;if(conflictRef.current){Message.warning('请先处理版本冲突');return false;}const r=revision.current;setStatus('保存中…');pending.current=(async()=>{try{const d=await noteApi('/notes/'+note.id,'PATCH',{version:latest.current.version,title:titleRef.current,content:editor?.getJSON()||latest.current.content,plainText:editor?.getText()||''});latest.current=d.note;savedContent.current=canon(d.note.content);onSave(d.note);if(r===revision.current){dirty.current=false;setStatus('已保存');}return true;}catch(e){if(e instanceof ApiError&&e.status===409&&e.data.note){conflictRef.current=e.data.note;setConflict(e.data.note);setStatus('版本冲突');}else setStatus('保存失败，点击重试');Message.error((e as Error).message);return false;}finally{pending.current=null;}})();const ok=await pending.current;if(ok&&dirty.current)return flush();return ok;}
// 对外提供最新的保存函数与版本；重新渲染不会清除尚未触发的自动保存计时器。
useImperativeHandle(bridge,()=>({flush,snapshot:()=>latest.current,hasChanges:()=>dirty.current,draft:()=>titleRef.current+'\n\n'+(editor?.getText()||'')}));
useEffect(()=>()=>clearTimeout(timer.current),[]);
useEffect(()=>{editor?.setEditable(!note.deletedAt&&!readOnly);if(dirty.current&&note.version>latest.current.version&&!conflictRef.current)setStatus('其他成员已更新，保存时将检查冲突');if(!dirty.current&&!pending.current){latest.current=note;titleRef.current=note.title;setTitle(note.title);if(editor&&canon(editor.getJSON())!==canon(note.content))editor.commands.setContent(note.content,false);savedContent.current=canon(note.content);}},[note,editor,readOnly]);
useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
const collaborationText=teamId?[note.modifiedBy&&'最后修改：'+note.modifiedBy,activeEditors.length>0&&activeEditors.join('、')+' 正在编辑'].filter(Boolean).join(' · '):'';
return <>
<div className="format-bar">
  <EditorTools editor={editor} disabled={!!note.deletedAt||readOnly}/>
  <div className="editor-save-info">
    {teamId&&<div className="editor-collaboration-info">{collaborationText&&<Text type="secondary" title={collaborationText}>{collaborationText}</Text>}{note.canEdit===false&&<Tag size="small">只读</Tag>}</div>}
    <Button title={status+' · 立即保存（Ctrl / ⌘ + S）'} className="save-status" type="text" size="mini" onClick={()=>void flush()} icon={status==='已保存'?<Check size={14}/>:undefined}>{status}</Button>
  </div>
</div>
{conflict&&<div className="conflict-body"><Alert type="warning" content={
  <div className="conflict-inner">
    <Paragraph style={{margin:0}}>其他成员或设备修改了这篇备忘录。你的编辑仍保留在此。</Paragraph>
    <Space size={8}>
      <Button size="small" onClick={()=>{latest.current=conflict;setTitle(conflict.title);titleRef.current=conflict.title;editor?.commands.setContent(conflict.content,false);savedContent.current=canon(conflict.content);dirty.current=false;conflictRef.current=null;setConflict(null);setStatus('已保存');onSave(conflict);}}>使用服务器版本</Button>
      <Button size="small" type="primary" onClick={async()=>{try{const d=await noteApi('/notes','POST',{folderId:latest.current.folderId});const copy=await noteApi('/notes/'+d.note.id,'PATCH',{version:d.note.version,title:titleRef.current+'（冲突副本）',content:editor?.getJSON(),plainText:editor?.getText()});onSave(copy.note);Message.success('你的编辑已另存为副本，可从列表打开');}catch(e){Message.error((e as Error).message);}}}>将我的编辑另存为副本</Button>
    </Space>
  </div>}/></div>}
<div className="document-scroll"><div className="document">
  <Text type="secondary" className="document-date">{new Date(note.updatedAt).toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</Text>
  <input className="title-input" aria-label="笔记标题" placeholder="新备忘录" maxLength={200} disabled={!!note.deletedAt||readOnly} value={title} onChange={e=>{const v=e.target.value;setTitle(v);titleRef.current=v;if(v===latest.current.title&&canon(editor?.getJSON())===savedContent.current){dirty.current=false;setStatus('已保存');}else changed();}}/>
  <EditorContent editor={editor}/>
</div></div>
<div className="editor-footer"><Text type="secondary">{editor?.getText().length||0} 字</Text><Text type="secondary">{note.deletedAt?'已移入最近删除，可恢复':readOnly?'只读':'自动保存已开启'}</Text></div>
</>;
});

export const NoteEditor=forwardRef<EditorBridge,{note:Note;onSave:(n:Note)=>void;user:User;readOnly?:boolean;teamId?:string|null}>(function NoteEditor(props,bridge){
  return props.teamId&&!props.note.deletedAt
    ? <Suspense fallback={<div className="editor-empty" role="status">正在加载协作编辑器…</div>}><TeamNoteEditor {...props} teamId={props.teamId} ref={bridge}/></Suspense>
    : <SavedNoteEditor {...props} ref={bridge}/>;
});
