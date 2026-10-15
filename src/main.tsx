import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Alert,Avatar,Button,Card,ConfigProvider,Dropdown,Empty,Input,List,Menu,Message,Modal,Select,Space,Spin,Tag,Tooltip,Typography} from '@arco-design/web-react';
import {ArrowLeft,Bold,BookOpen,Check,Edit3,Folder,Heading2,Italic,List as ListIcon,ListChecks,ListOrdered,LogOut,MoreHorizontal,Pencil,Plus,Redo2,Search,Star,Trash2,Undo2} from 'lucide-react';
import {useEditor,EditorContent} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import '@arco-design/web-react/dist/css/arco.css';
import './style.css';

const {Text,Title,Paragraph} = Typography;

type Note={id:string;title:string;content:any;plainText:string;folderId:string|null;pinned:boolean;deletedAt:string|null;version:number;createdAt:string;updatedAt:string};
type Folder={id:string;name:string};

class ApiError extends Error{constructor(public status:number, public data:any){super(data.error||'请求失败');}}
async function api(path:string,method='GET',body?:any){const r=await fetch('/api'+path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new ApiError(r.status,data);return data;}
const date=(s:string)=>new Date(s).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
const Ico=({Icon,text}:{Icon:any;text:string})=><span className="ico-label"><Icon size={16}/><span>{text}</span></span>;

function App(){
const [user,setUser]=useState<{id:string;username:string}|null>(null),[boot,setBoot]=useState(true),[authMode,setAuthMode]=useState(false),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[authBusy,setAuthBusy]=useState(false);
const [notes,setNotes]=useState<Note[]>([]),[folders,setFolders]=useState<Folder[]>([]),[scope,setScope]=useState('all'),[search,setSearch]=useState(''),[selected,setSelected]=useState<string|null>(null),[mobile,setMobile]=useState(false);
const [loading,setLoading]=useState(false);const [folderDialog,setFolderDialog]=useState<{mode:'create'|'rename';id?:string;name:string}|null>(null);
const editorRef=useRef<{flush:()=>Promise<boolean>}|null>(null);
const current=notes.find(n=>n.id===selected);

function upsert(n:Note){setNotes(prev=>prev.some(x=>x.id===n.id)?prev.map(x=>x.id===n.id?n:x):[n,...prev]);}
async function reload(){setLoading(true);try{const [a,b]=await Promise.all([api('/notes'),api('/folders')]);setNotes(a.notes);setFolders(b.folders);}catch(e){Message.error((e as Error).message);}finally{setLoading(false);}}
useEffect(()=>{api('/auth/me').then(d=>setUser(d.user)).catch(()=>{}).finally(()=>setBoot(false));},[]);
useEffect(()=>{if(user)void reload();},[user]);

async function auth(e:React.FormEvent){e.preventDefault();setAuthBusy(true);try{const d=await api('/auth/'+(authMode?'register':'login'),'POST',{username,password});setUser(d.user);setPassword('');}catch(e){Message.error((e as Error).message);}finally{setAuthBusy(false);}}
async function safeSwitch(fn:()=>void){if(editorRef.current && !await editorRef.current.flush())return;fn();}
function switchScope(key:string){void safeSwitch(()=>{setScope(key);setMobile(false);});}
async function newNote(){await safeSwitch(async()=>{try{const d=await api('/notes','POST',{folderId:folders.some(f=>f.id===scope)?scope:null});upsert(d.note);setSelected(d.note.id);if(scope==='trash'||scope==='pinned')setScope('all');setSearch('');setMobile(true);}catch(e){Message.error((e as Error).message);}});}
async function mutate(patch:any){if(!current)return;if(editorRef.current&&!await editorRef.current.flush())return;try{const fresh=await api('/notes');const n=fresh.notes.find((x:Note)=>x.id===current.id);const d=await api('/notes/'+current.id,'PATCH',{version:n.version,...patch});upsert(d.note);}catch(e){if(e instanceof ApiError&&e.data.note)upsert(e.data.note);Message.error((e as Error).message);}}
async function permaDelete(){if(!current)return;Modal.confirm({title:'永久删除这篇笔记？',content:'此操作无法撤销，笔记内容将无法恢复。',onOk:async()=>{try{await api('/notes/'+current.id,'DELETE');setNotes(p=>p.filter(n=>n.id!==current.id));setSelected(null);}catch(e){Message.error((e as Error).message);throw e;}}});}
async function logout(){await safeSwitch(async()=>{try{await api('/auth/logout','POST');setUser(null);setNotes([]);setSelected(null);}catch(e){Message.error((e as Error).message);}});}
async function submitFolderDialog(){const d=folderDialog;if(!d)return;const name=d.name.trim();if(!name){Message.warning('请输入文件夹名称');throw new Error('empty');}try{if(d.mode==='create')await api('/folders','POST',{name});else await api('/folders/'+d.id,'PATCH',{name});setFolderDialog(null);await reload();}catch(e){Message.error((e as Error).message);throw e;}}
function renameFolder(f:Folder){setFolderDialog({mode:'rename',id:f.id,name:f.name});}
async function createNoteInFolder(f:Folder){await safeSwitch(async()=>{try{const d=await api('/notes','POST',{folderId:f.id});upsert(d.note);setScope(f.id);setSelected(d.note.id);setSearch('');setMobile(true);}catch(e){Message.error((e as Error).message);}});}
function deleteFolder(f:Folder){Modal.confirm({title:'删除文件夹',content:`删除「${f.name}」后，其中的笔记将移动到未分类。`,onOk:async()=>{if(editorRef.current&&!await editorRef.current.flush())throw new Error('请先保存当前笔记');await api('/folders/'+f.id,'DELETE');if(scope===f.id)setScope('all');await reload();}});}
function folderAction(key:string,f:Folder){if(key==='new')void createNoteInFolder(f);else if(key==='rename')renameFolder(f);else deleteFolder(f);}

let visible=notes.filter(n=>scope==='trash'?!!n.deletedAt:!n.deletedAt&&(scope==='all'||scope==='pinned'&&n.pinned||n.folderId===scope)).filter(n=>(n.title+' '+n.plainText).toLowerCase().includes(search.toLowerCase())).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt));
const scopeName=scope==='all'?'所有备忘录':scope==='pinned'?'已置顶':scope==='trash'?'最近删除':folders.find(f=>f.id===scope)?.name||'备忘录';

if(boot)return <div className="boot"><Spin tip="正在打开你的备忘录"/></div>;
if(!user)return <div className="auth-page"><Card className="auth-card">
  <div className="auth-brand"><img src="/favicon.svg" width={40} height={40} alt="拾记"/><Title heading={4} style={{margin:0}}>拾记</Title></div>
  <Paragraph type="secondary">{authMode?'创建你的账号，让每个想法都有归处。':'登录后，继续上次的灵感。'}</Paragraph>
  <form className="auth-form" onSubmit={auth}>
    <label><Text type="secondary">用户名</Text></label>
    <Input autoComplete="username" value={username} onChange={setUsername} placeholder="3–32 个字符" maxLength={32}/>
    <label><Text type="secondary">密码</Text></label>
    <Input.Password autoComplete={authMode?'new-password':'current-password'} value={password} onChange={setPassword} placeholder="至少 8 个字符" maxLength={128}/>
    <Button className="auth-submit" type="primary" long htmlType="submit" loading={authBusy}>{authMode?'创建账号':'登录'}</Button>
  </form>
  <div className="auth-switch"><Text type="secondary">{authMode?'已有账号？':'还没有账号？'}</Text><Button type="text" size="small" onClick={()=>setAuthMode(!authMode)}>{authMode?'去登录':'创建账号'}</Button></div>
</Card></div>;

return <div className={'app-shell'+(mobile?' mobile-edit':'')}>
<aside className="sidebar">
  <div className="sidebar-brand"><img src="/favicon.svg" width={32} height={32} alt="拾记"/><Title heading={6} style={{margin:0}}>拾记</Title></div>
  <Menu selectedKeys={[scope]} onClickMenuItem={key=>switchScope(String(key))}>
    <Menu.Item key="all"><Ico Icon={BookOpen} text="所有备忘录"/></Menu.Item>
    <Menu.Item key="pinned"><Ico Icon={Star} text="已置顶"/></Menu.Item>
    <Menu.ItemGroup className="folder-group" title={<span className="group-title">文件夹<Tooltip content="新建文件夹"><Button type="text" size="mini" aria-label="新建文件夹" icon={<Plus size={14}/>} onClick={e=>{e.stopPropagation();setFolderDialog({mode:'create',name:''});}}/></Tooltip></span>}>
      {folders.map(f=><Menu.Item key={f.id}><span className="folder-item"><Ico Icon={Folder} text={f.name}/><Dropdown trigger="click" position="br" droplist={<Menu onClickMenuItem={key=>folderAction(String(key),f)}>
        <Menu.Item key="new"><Ico Icon={Pencil} text="在此新建笔记"/></Menu.Item>
        <Menu.Item key="rename"><Ico Icon={Edit3} text="重命名"/></Menu.Item>
        <Menu.Item key="delete"><Ico Icon={Trash2} text="删除文件夹"/></Menu.Item>
      </Menu>}><Button className="folder-dots" type="text" size="mini" aria-label={'管理'+f.name} icon={<MoreHorizontal size={14}/>} onClick={e=>e.stopPropagation()}/></Dropdown></span></Menu.Item>)}
    </Menu.ItemGroup>
    <Menu.Item key="trash"><Ico Icon={Trash2} text="最近删除"/></Menu.Item>
  </Menu>
  <div className="sidebar-footer">
    <div className="user-row">
      <Avatar size={28} style={{background:'rgb(var(--primary-6))'}}>{user.username[0].toUpperCase()}</Avatar>
      <div className="user-meta"><Text>{user.username}</Text><br/><Text type="secondary">个人备忘录</Text></div>
      <Tooltip content="退出登录"><Button type="text" size="mini" icon={<LogOut size={16}/>} onClick={()=>void logout()}/></Tooltip>
    </div>
  </div>
</aside>
<section className="note-list">
  <div className="note-list-head">
    <div><Title heading={6} style={{margin:0}}>{scopeName}</Title><Text type="secondary">{visible.length} 篇</Text></div>
    <Tooltip content="新建备忘录"><Button type="primary" size="small" icon={<Pencil size={16}/>} onClick={()=>void newNote()}/></Tooltip>
  </div>
  <div className="list-scroll">
    {/* 搜索框放进滚动容器内并吸顶：与卡片共用同一内容宽度，
        否则滚动条占位会让卡片比搜索框窄一圈 */}
    <div className="note-search"><Input allowClear prefix={<Search size={16}/>} placeholder="搜索备忘录" value={search} onChange={setSearch}/></div>
    <Spin loading={loading} style={{display:'block'}}>
      {visible.length===0
        ?<div className="list-empty"><Empty description={search?'没有匹配的备忘录':'这里还没有备忘录'}/>{scope!=='trash'&&<Button type="primary" size="small" onClick={()=>void newNote()}>写下第一条</Button>}</div>
        :<List grid={{gutter:[0,16],span:24}} bordered={false} split={false} dataSource={visible} render={(n:Note)=>(
          <Card key={n.id} data-note-id={n.id} size="small" className="note-card"
            style={selected===n.id?{borderColor:'rgb(var(--primary-6))',background:'rgb(var(--primary-1))'}:undefined}
            onClick={()=>void safeSwitch(()=>{setSelected(n.id);setMobile(true);})}>
            <div className="note-card-content">
              <div className="note-card-head">
                <Text className="note-card-title" style={{fontWeight:600}}>{n.title||'新备忘录'}</Text>
                {n.pinned&&<Tag size="small" color="gold">置顶</Tag>}
              </div>
              <Text type="secondary" className="note-card-desc">{date(n.updatedAt)} · {n.plainText.slice(0,50)||'暂无内容'}</Text>
            </div>
          </Card>)}/>
      }
    </Spin>
  </div>
</section>
<main className="editor-pane">
  {current
    ?<><div className="editor-header">
        <Space size={4}>
          <Tooltip content="返回列表"><Button className="back" type="text" size="small" aria-label="返回列表" icon={<ArrowLeft size={16}/>} onClick={()=>void safeSwitch(()=>setMobile(false))}/></Tooltip>
          <Text type="secondary">{current.deletedAt?'最近删除':folders.find(f=>f.id===current.folderId)?.name||'未分类'}</Text>
        </Space>
        <Space size={4}>
          {current.deletedAt
            ?<><Button size="small" onClick={()=>void mutate({deletedAt:null})}>恢复笔记</Button>
               <Button size="small" status="danger" onClick={()=>void permaDelete()}>永久删除</Button></>
            :<><Tooltip content={current.pinned?'取消置顶':'置顶笔记'}><Button size="small" type={current.pinned?'primary':'text'} onClick={()=>void mutate({pinned:!current.pinned})}>{current.pinned?'已置顶':'置顶'}</Button></Tooltip>
               <Select size="small" value={current.folderId??''} style={{width:130}} onChange={v=>void mutate({folderId:v||null})}>
                 <Select.Option value="">未分类</Select.Option>
                 {folders.map(f=><Select.Option key={f.id} value={f.id}>{f.name}</Select.Option>)}
               </Select>
               <Tooltip content="移到最近删除"><Button size="small" type="text" status="danger" icon={<Trash2 size={16}/>} onClick={()=>void mutate({deletedAt:new Date().toISOString()})}/></Tooltip></>}
        </Space>
      </div>
      <NoteEditor key={current.id} note={current} onSave={upsert} bridge={editorRef}/>
    </>
    :<div className="editor-empty">
      <Empty description="留一点空间，给灵感"/>
      <Button type="primary" icon={<Plus size={16}/>} onClick={()=>void newNote()}>新建备忘录</Button>
    </div>}
</main>
<Modal title={folderDialog?.mode==='rename'?'重命名文件夹':'新建文件夹'} visible={!!folderDialog} onOk={()=>submitFolderDialog()} onCancel={()=>setFolderDialog(null)} maskClosable={false}>
  <Input autoFocus placeholder="请输入文件夹名称" maxLength={60} value={folderDialog?.name||''} onChange={name=>setFolderDialog(p=>p?{...p,name}:null)} onPressEnter={()=>void submitFolderDialog()}/>
</Modal>
</div>;
}

// 结构化比较，忽略对象键顺序差异（数据库里存的 JSON 与 Tiptap 重新序列化的键序可能不同）
function canon(v:any):string{
  if(Array.isArray(v))return '['+v.map(canon).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
  return JSON.stringify(v);
}

function NoteEditor({note,onSave,bridge}:{note:Note;onSave:(n:Note)=>void;bridge:React.MutableRefObject<{flush:()=>Promise<boolean>}|null>}){
const [title,setTitle]=useState(note.title),[status,setStatus]=useState('已保存'),[conflict,setConflict]=useState<Note|null>(null);
const latest=useRef(note),dirty=useRef(false),timer=useRef<ReturnType<typeof setTimeout>>(),revision=useRef(0),pending=useRef<Promise<boolean>|null>(null);
// 最近一次成功入库的正文，用于判断「这次变更是否真的改了内容」
const savedContent=useRef(canon(note.content));
const editor=useEditor({extensions:[StarterKit,TaskList,TaskItem.configure({nested:true})],content:note.content,editable:!note.deletedAt,onUpdate:({editor})=>{
  // Tiptap 在聚焦、选区变化等情况下也会触发 update，此时文档其实没变。
  // 若一律标脏，单纯「点开一篇笔记」就会保存一次并刷新修改时间，笔记随即跳到列表最前。
  if(canon(editor.getJSON())===savedContent.current)return;
  changed();
}});
const titleRef=useRef(title);titleRef.current=title;
function changed(){dirty.current=true;revision.current++;setStatus('尚未保存');clearTimeout(timer.current);timer.current=setTimeout(()=>void flush(),700);}
async function flush():Promise<boolean>{clearTimeout(timer.current);if(pending.current){await pending.current;if(dirty.current&&!conflict)return flush();return !dirty.current;}if(!dirty.current)return true;if(conflict){Message.warning('请先处理版本冲突');return false;}const r=revision.current;setStatus('保存中…');pending.current=(async()=>{try{const d=await api('/notes/'+note.id,'PATCH',{version:latest.current.version,title:titleRef.current,content:editor?.getJSON()||latest.current.content,plainText:editor?.getText()||''});latest.current=d.note;savedContent.current=canon(d.note.content);onSave(d.note);if(r===revision.current){dirty.current=false;setStatus('已保存');}return true;}catch(e){if(e instanceof ApiError&&e.status===409&&e.data.note){setConflict(e.data.note);setStatus('版本冲突');}else setStatus('保存失败，点击重试');Message.error((e as Error).message);return false;}finally{pending.current=null;}})();const ok=await pending.current;if(ok&&dirty.current)return flush();return ok;}
// bridge 每次渲染都指向最新的 flush（flush 会随渲染重建），
// 但 cleanup 绝不能清掉待执行的自动保存定时器 —— 否则输入后 700ms 的保存会被自己取消
useEffect(()=>{bridge.current={flush};return()=>{bridge.current=null;};},[flush]);
useEffect(()=>()=>clearTimeout(timer.current),[]);
useEffect(()=>{editor?.setEditable(!note.deletedAt);if(!dirty.current&&!pending.current){latest.current=note;savedContent.current=canon(note.content);}},[note,editor]);
useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[]);
const tools=[{label:'标题',icon:<Heading2 size={16}/>,active:editor?.isActive('heading',{level:2}),run:()=>editor?.chain().focus().toggleHeading({level:2}).run()},{label:'粗体',icon:<Bold size={16}/>,active:editor?.isActive('bold'),run:()=>editor?.chain().focus().toggleBold().run()},{label:'斜体',icon:<Italic size={16}/>,active:editor?.isActive('italic'),run:()=>editor?.chain().focus().toggleItalic().run()},{label:'无序列表',icon:<ListIcon size={16}/>,active:editor?.isActive('bulletList'),run:()=>editor?.chain().focus().toggleBulletList().run()},{label:'有序列表',icon:<ListOrdered size={16}/>,active:editor?.isActive('orderedList'),run:()=>editor?.chain().focus().toggleOrderedList().run()},{label:'待办清单',icon:<ListChecks size={16}/>,active:editor?.isActive('taskList'),run:()=>editor?.chain().focus().toggleTaskList().run()},{label:'撤销',icon:<Undo2 size={16}/>,run:()=>editor?.chain().focus().undo().run()},{label:'重做',icon:<Redo2 size={16}/>,run:()=>editor?.chain().focus().redo().run()}];
return <>
<div className="format-bar">
  <Space size={4}>{tools.map(t=><Tooltip key={t.label} content={t.label}><Button size="small" type={t.active?'secondary':'text'} disabled={!!note.deletedAt} aria-label={t.label} icon={t.icon} onClick={t.run}/></Tooltip>)}</Space>
  <Button className="save-status" type="text" size="mini" onClick={()=>void flush()} icon={status==='已保存'?<Check size={14}/>:undefined}>{status}</Button>
</div>
{conflict&&<div className="conflict-body"><Alert type="warning" content={
  <div className="conflict-inner">
    <Paragraph style={{margin:0}}>另一台设备修改了这篇笔记。你的编辑仍保留在此。</Paragraph>
    <Space size={8}>
      <Button size="small" onClick={()=>{latest.current=conflict;setTitle(conflict.title);titleRef.current=conflict.title;editor?.commands.setContent(conflict.content,false);savedContent.current=canon(conflict.content);dirty.current=false;setConflict(null);setStatus('已保存');onSave(conflict);}}>使用服务器版本</Button>
      <Button size="small" type="primary" onClick={async()=>{try{const d=await api('/notes','POST',{folderId:latest.current.folderId});const copy=await api('/notes/'+d.note.id,'PATCH',{version:d.note.version,title:titleRef.current+'（冲突副本）',content:editor?.getJSON(),plainText:editor?.getText()});onSave(copy.note);Message.success('你的编辑已另存为副本，可从列表打开');}catch(e){Message.error((e as Error).message);}}}>将我的编辑另存为副本</Button>
    </Space>
  </div>}/></div>}
<div className="document-scroll"><div className="document">
  <Text type="secondary" className="document-date">{new Date(note.updatedAt).toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}</Text>
  <input className="title-input" aria-label="笔记标题" placeholder="新备忘录" maxLength={200} disabled={!!note.deletedAt} value={title} onChange={e=>{const v=e.target.value;setTitle(v);titleRef.current=v;if(v===latest.current.title&&canon(editor?.getJSON())===savedContent.current){dirty.current=false;setStatus('已保存');}else changed();}}/>
  <EditorContent editor={editor}/>
</div></div>
<div className="editor-footer"><Text type="secondary">{editor?.getText().length||0} 字</Text><Text type="secondary">{note.deletedAt?'已移入最近删除，可恢复':'自动保存已开启'}</Text></div>
</>;
}
createRoot(document.getElementById('root')!).render(<ConfigProvider><App/></ConfigProvider>);
