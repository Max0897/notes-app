import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {randomUUID} from 'node:crypto';
const dom = new JSDOM('<!doctype html><html><body><div id="tools"></div><div id="preview"></div></body></html>', {url: 'http://127.0.0.1/', pretendToBeVisual: true});
for (const key of ['window','document','navigator','location','Node','Element','HTMLElement','HTMLInputElement','HTMLIFrameElement','SVGElement','DocumentFragment','DOMParser','MutationObserver','getComputedStyle','MouseEvent','FocusEvent','KeyboardEvent','Event','CustomEvent','ShadowRoot','File','Blob','FormData']) Object.defineProperty(globalThis, key, {value: dom.window[key], configurable: true, writable: true});
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0); globalThis.cancelAnimationFrame = clearTimeout;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0});
class ResizeObserver {observe(){} unobserve(){} disconnect(){}}
globalThis.ResizeObserver = window.ResizeObserver = ResizeObserver;
window.matchMedia = query => ({media: query, matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}});
const requests = [];
class Request {
  upload = {}; status = 0; responseText = '';
  open(method, path) {this.method = method; this.path = path;}
  send(body) {this.body = body; requests.push(this);}
  abort() {this.aborted = true; this.onabort?.();}
  respond(status = 201, body = null) {this.status = status; const id = randomUUID(); this.responseText = JSON.stringify(body ?? {image: {id, src: '/api/images/' + id}}); this.onload?.();}
}
globalThis.XMLHttpRequest = Request;
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {Editor} = await import('@tiptap/core');
const {default: StarterKit} = await import('@tiptap/starter-kit');
const {default: Collaboration} = await import('@tiptap/extension-collaboration');
const Y = await import('yjs');
const {EditorImage, ImageUploads, hasImageUploads, finishImageUploads} = await import('../src/editorImages.ts');
const {EditorTools} = await import('../src/EditorTools.tsx');
const {ImagePreview} = await import('../src/ImagePreview.tsx');
const {Message} = await import('@arco-design/web-react');
const editor = new Editor({element: document.body.appendChild(document.createElement('div')), extensions: [StarterKit, EditorImage, ImageUploads.configure({path: '/api/notes/test/images'})], content: '<p>原文</p>'});
const tools = createRoot(document.getElementById('tools')), preview = createRoot(document.getElementById('preview'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const click = element => {assert(element); element.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));};
const file = () => new File([new Uint8Array([1, 2, 3])], '图片.png', {type: 'image/png'});
const imageNodes = () => editor.getJSON().content.filter(node => node.type === 'image');
const last = () => requests.at(-1);
function pointer(target, type, x, y, pointerId = 1, pointerType = 'mouse') {
  const event = new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0});
  Object.defineProperties(event, {pointerId: {value: pointerId}, pointerType: {value: pointerType}});
  target.dispatchEvent(event);
}
function resizeChecks() {
  const id = randomUUID(), src = '/api/images/' + id;
  const resized = new Editor({element: document.body.appendChild(document.createElement('div')), extensions: [StarterKit, EditorImage], content: {type: 'doc', content: [{type: 'image', attrs: {imageId: id, src}}, {type: 'paragraph'}]}});
  let restored;
  try {
    const figure = resized.view.dom.querySelector('.editor-image'), img = figure.querySelector('img'), handle = figure.querySelector('button');
    Object.defineProperty(resized.view.dom, 'clientWidth', {value: 480});
    img.getBoundingClientRect = () => {const width = Math.min(parseFloat(figure.style.width) || 320, 480); return {width, height: width * .75};};
    let changes = 0; resized.on('transaction', ({transaction}) => {if (transaction.docChanged) changes++;});
    const width = () => resized.getJSON().content[0].attrs.width;
    pointer(handle, 'pointerdown', 100, 100);
    pointer(window, 'pointermove', 180, 160); pointer(window, 'pointermove', 200, 175);
    assert.equal(width(), null); assert.equal(changes, 0, '拖动只更新本地预览'); assert.equal(figure.style.width, '420px');
    pointer(window, 'pointerup', 200, 175); assert.equal(width(), 420); assert.equal(changes, 1, '松开只提交一次正文变更');
    assert.equal(img.style.width, '100%');
    resized.commands.undo(); assert.equal(width(), null); resized.commands.redo(); assert.equal(width(), 420);
    restored = new Editor({element: document.body.appendChild(document.createElement('div')), extensions: [StarterKit, EditorImage], content: resized.getHTML()});
    assert.equal(restored.getJSON().content[0].attrs.width, 420, '复制粘贴保留尺寸');
    pointer(handle, 'pointerdown', 100, 100, 2, 'touch'); pointer(window, 'pointermove', 600, 475, 2, 'touch'); pointer(window, 'pointerup', 600, 475, 2, 'touch');
    assert.equal(width(), 480, '触摸缩放不超过编辑区');
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', -1000, -725); pointer(window, 'pointerup', -1000, -725);
    assert.equal(width(), 80, '最小尺寸');
    handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true}));
    assert.equal(width(), 130, '键盘可调节图片尺寸');
    for (const reason of ['pointercancel', 'Escape', 'blur', 'readonly']) {
      pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 160, 145);
      if (reason === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
      else if (reason === 'readonly') resized.setEditable(false);
      else if (reason === 'pointercancel') pointer(window, reason, 160, 145);
      else window.dispatchEvent(new Event(reason));
      pointer(window, 'pointerup', 160, 145);
      assert.equal(width(), 130, reason + ' 取消缩放'); assert.equal(figure.style.width, '130px');
      resized.setEditable(true);
    }
    resized.setEditable(false); assert(handle.hidden); pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 200, 175); pointer(window, 'pointerup', 200, 175);
    assert.equal(width(), 130, '只读不能缩放'); resized.setEditable(true); assert(!handle.hidden);
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 200, 175);
    resized.commands.insertContentAt(0, '<p>协作插入文字</p>'); pointer(window, 'pointerup', 200, 175);
    assert.equal(resized.getJSON().content[1].attrs.width, 230, '正文变化后仍定位原图片');
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 200, 175);
    const pos = resized.state.doc.firstChild.nodeSize;
    resized.view.dispatch(resized.state.tr.delete(pos, pos + 1)); pointer(window, 'pointerup', 200, 175);
    assert(!resized.getJSON().content.some(node => node.type === 'image'), '缩放期间删除图片不会复活节点');
    const unsafe = new Editor({element: document.body.appendChild(document.createElement('div')), extensions: [StarterKit, EditorImage], content: `<img src="${src}" width="99999" />`});
    try {assert.equal(unsafe.getJSON().content[0].attrs.width, null, '粘贴时过滤非法尺寸');} finally {unsafe.destroy();}
    console.log('PASS 图片缩放、单次提交/撤销、触摸与键盘、剪贴板尺寸、取消、只读及节点变更');
  } finally {restored?.destroy(); resized.destroy();}
}
async function collaborativeResizeChecks() {
  const a = new Y.Doc(), b = new Y.Doc(), editors = [];
  a.on('update', (update, origin) => {if (origin !== b) Y.applyUpdate(b, update, a);});
  b.on('update', (update, origin) => {if (origin !== a) Y.applyUpdate(a, update, b);});
  try {
    const makeEditor = document => {
      const editor = new Editor({element: window.document.body.appendChild(window.document.createElement('div')), extensions: [StarterKit.configure({history: false}), EditorImage, Collaboration.configure({document})]});
      editors.push(editor); return editor;
    };
    const first = makeEditor(a); await delay(20);
    const id = randomUUID(); first.commands.setContent({type: 'doc', content: [{type: 'image', attrs: {imageId: id, src: '/api/images/' + id}}, {type: 'paragraph'}]});
    first.commands.setTextSelection(2);
    const second = makeEditor(b); await delay(20);
    second.commands.setTextSelection(2);
    const figure = first.view.dom.querySelector('.editor-image'), handle = figure.querySelector('button');
    Object.defineProperty(first.view.dom, 'clientWidth', {value: 640});
    figure.querySelector('img').getBoundingClientRect = () => {const width = parseFloat(figure.style.width) || 320; return {width, height: width * .75};};
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 200, 175); pointer(window, 'pointerup', 200, 175);
    assert.equal(second.getJSON().content[0].attrs.width, 420, '编辑器绑定同步图片宽度');
    first.commands.undo();
    assert.equal(second.getJSON().content[0].type, 'image'); assert.equal(second.getJSON().content[0].attrs.width, null, 'Yjs 单次撤销仅恢复尺寸');
    first.commands.redo(); assert.equal(second.getJSON().content[0].attrs.width, 420);
    pointer(handle, 'pointerdown', 100, 100); pointer(window, 'pointermove', 180, 160);
    second.view.dispatch(second.state.tr.setNodeMarkup(0, undefined, {...second.state.doc.firstChild.attrs, width: 280}));
    pointer(window, 'pointerup', 180, 160);
    assert.equal(first.getJSON().content[0].attrs.width, 280, '同伴调整尺寸时取消本次未完成拖动');
    assert.equal(figure.style.width, '280px');
    console.log('PASS 两端编辑器尺寸同步、Yjs 缩放独立撤销及并发尺寸更新');
  } finally {editors.forEach(editor => editor.destroy()); a.destroy(); b.destroy();}
}
try {
  tools.render(React.createElement(EditorTools, {editor, disabled: false}));
  preview.render(React.createElement(ImagePreview)); await delay(60);
  let picker;
  const oldClick = window.HTMLInputElement.prototype.click;
  window.HTMLInputElement.prototype.click = function() {picker = this;};
  click(document.querySelector('button[aria-label="插入内容"]')); await delay(60);
  click([...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === '图片'));
  window.HTMLInputElement.prototype.click = oldClick;
  assert.equal(picker.accept, 'image/jpeg,image/png,image/webp'); assert(picker.multiple);
  Object.defineProperty(picker, 'files', {value: [file()]}); picker.dispatchEvent(new Event('change'));
  assert(hasImageUploads(editor)); assert.equal(last().path, '/api/notes/test/images');
  assert(document.querySelector('.image-upload')); assert.equal(imageNodes().length, 0);
  last().upload.onprogress({lengthComputable: true, loaded: 2, total: 10}); assert(document.querySelector('.image-upload').textContent.includes('20%'));
  editor.commands.insertContentAt(1, '新增'); last().respond();
  assert(await finishImageUploads(editor)); assert.equal(imageNodes().length, 1); assert(editor.getText().includes('新增原文'));
  assert.equal(JSON.stringify(editor.getJSON()).includes('blob:'), false);
  console.log('PASS 工具栏选图、占位/进度、上传中继续输入、完成后插入正式引用');

  const count = requests.length; editor.commands.uploadImages([file(), file(), file()]);
  assert.equal(requests.length, count + 2); requests[count].respond(); assert.equal(requests.length, count + 3);
  requests[count + 1].respond(); requests[count + 2].respond(); assert(await finishImageUploads(editor)); assert.equal(imageNodes().length, 4);
  const ordered = requests.length, firstId = randomUUID(), secondId = randomUUID();
  editor.commands.setTextSelection(1); editor.commands.uploadImages([file(), file()]);
  requests[ordered + 1].respond(201, {image: {id: secondId, src: '/api/images/' + secondId}});
  requests[ordered].respond(201, {image: {id: firstId, src: '/api/images/' + firstId}});
  assert(await finishImageUploads(editor));
  const ids = imageNodes().map(node => node.attrs.imageId); assert(ids.indexOf(firstId) < ids.indexOf(secondId), '完成顺序不改变图片顺序');
  editor.commands.uploadImages([file()]); last().respond(500, {error: '暂时失败'});
  assert(document.querySelector('.image-upload').textContent.includes('暂时失败'));
  assert.equal(await finishImageUploads(editor), false);
  click([...document.querySelectorAll('.image-upload button')].find(button => button.textContent === '重试'));
  last().respond(); assert(await finishImageUploads(editor));
  editor.commands.uploadImages([file()]); const cancelled = last(); click([...document.querySelectorAll('.image-upload button')].find(button => button.textContent === '取消'));
  assert(cancelled.aborted); assert(!hasImageUploads(editor));
  console.log('PASS 最多两张并行上传、排队、失败阻止离开、重试及取消');

  const paste = new Event('paste', {bubbles: true, cancelable: true}); Object.defineProperty(paste, 'clipboardData', {value: {files: [file()], getData: () => '', types: ['Files']}});
  editor.view.dom.dispatchEvent(paste); assert(paste.defaultPrevented); assert(hasImageUploads(editor)); last().respond(); assert(await finishImageUploads(editor));
  let handled = false; editor.view.posAtCoords = () => ({pos: 1, inside: -1});
  editor.view.someProp('handleDrop', handler => {if (handler(editor.view, {dataTransfer: {files: [file()]}, clientX: 0, clientY: 0, preventDefault(){handled = true;}}, null, false)) return true;});
  assert(handled); last().respond(); assert(await finishImageUploads(editor));
  click(editor.view.dom.querySelector('.editor-image img')); await delay(60); assert(document.querySelector('.arco-image-preview'));
  window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', keyCode: 27, bubbles: true})); await delay(40);
  console.log('PASS 粘贴截图、拖入图片及点击放大预览');

  const original = imageNodes().length; editor.commands.undo(); assert.equal(imageNodes().length, original - 1); editor.commands.redo(); assert.equal(imageNodes().length, original);
  resizeChecks();
  await collaborativeResizeChecks();
  editor.setEditable(false); assert.equal(editor.commands.uploadImages([file()]), false);
  editor.setEditable(true); editor.commands.uploadImages([file()]); const ending = last(); editor.destroy(); assert(ending.aborted);
  console.log('PASS 插图撤销/重做、只读限制与卸载时中止上传');
} finally {Message.clear(); tools.unmount(); preview.unmount(); if (!editor.isDestroyed) editor.destroy(); await delay(400); dom.window.close();}
