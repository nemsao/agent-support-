// Run the actual React panel/popup in an isolated, hidden Electron window.
// All accounts, AI responses and Zalo IPC calls are fixtures; no real messages.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deplao-chat-zalo-test-'));
  const statePath = path.join(temp, 'state.js');
  fs.writeFileSync(statePath, `
    export const sent = [], saved = [];
    export const controls = {slowAssistant: true, slowConversation: false, slowHistory: false, resolveHistory: null};
    let requestId = 0;
    export const accountState = { activeAccountId: 'sender-a', accounts: [
      { zalo_id: 'sender-a', full_name: 'Sender A', channel: 'zalo' },
      { zalo_id: 'sender-b', full_name: 'Sender B', channel: 'zalo' },
      { zalo_id: 'facebook', full_name: 'Facebook fixture', channel: 'facebook' },
    ] };
    export const chatState = { activeThreadId: 'thread-1', messages: {} };
    export const appState = {
      labels: {}, groupInfoCache: {}, aiAutoInjectZaloContext: false,
      aiQuickPanelContextCountOverride: null, aiThreadAssistantMap: {},
      setAiThreadAssistant() {}, setAiAutoInjectZaloContext() {}, setAiQuickPanelContextCountOverride() {},
    };
    export const accessor = {
      async getCRMContacts({zaloId, opts}) {
        let contacts = zaloId === 'sender-a' ? [
          {contact_id:'user-a', display_name:'NCC A', contact_type:'user'},
          {contact_id:'group-a', display_name:'Nhóm NCC A', contact_type:'group'},
        ] : [{contact_id:'group-b', display_name:'Nhóm NCC B', contact_type:'group'}];
        if (opts.contactType === 'group') contacts = contacts.filter(c => c.contact_type === 'group');
        if (opts.search) contacts = contacts.filter(c => c.display_name.includes(opts.search));
        return {contacts, total: contacts.length};
      },
      async getLocalLabels() { return {labels: []}; },
      async getLocalLabelThreads() { return {threads: []}; },
    };
    export const ipc = {
      ai: {
        async listAssistants() { return {success:true, assistants:[{id:'assistant',name:'Fixture AI',enabled:true}]}; },
        async getAssistant() {
          if (controls.slowAssistant) return new Promise(() => {});
          return {success:true,assistant:{}};
        },
        async getOrCreateConversation({threadId}) {
          if (controls.slowConversation) return new Promise(() => {});
          return {success:true,conversation:{id:threadId}};
        },
        async getConversationMessages() {
          if (controls.slowHistory) return new Promise(resolve => {
            controls.resolveHistory = () => resolve({success:true,messages:[{role:'assistant',content:'LỊCH SỬ CŨ ĐẾN MUỘN'}]});
          });
          return {success:true,messages:[]};
        },
        async addConversationMessage(message) { saved.push(message); return {success:true}; },
        async chat() { return {success:true,result:JSON.stringify([{type:'text',content:'Chọn người nhận'}]),
          recipientRequest:{id:String(++requestId),type:'select_zalo_recipients',message:'Xin giá 100 sản phẩm X'}}; },
      },
      zalo: {async sendMessage(params) {
        sent.push(params);
        await new Promise(resolve => setTimeout(resolve, 30));
        return params.threadId === 'group-a' ? {success:false,error:'Lỗi fixture'} : {success:true};
      }},
    };
  `);
  const mocks = {
    '@/lib/ipc': 'export {ipc as default} from "fixture-state";',
    '@/store/accountStore': 'import {accountState} from "fixture-state"; export const useAccountStore = Object.assign(() => accountState, {getState:() => accountState});',
    '@/store/chatStore': 'import {chatState} from "fixture-state"; export const useChatStore = Object.assign(() => chatState, {getState:() => chatState});',
    '@/store/appStore': 'import {appState} from "fixture-state"; export const useAppStore = Object.assign(() => appState, {getState:() => appState});',
    '@/lib/data/DataAccessor': 'export {accessor as default} from "fixture-state";',
    '../common/GroupAvatar': 'export default function GroupAvatar(){return null}',
    '../common/ChannelBadge': 'export default function ChannelBadge(){return null}',
    '@/lib/localMedia': 'export const toLocalMediaUrl = value => value;',
    '@/lib/chat/messageParser': 'export const formatMsgTime = () => "";',
    '@/components/common/icons': 'export const BotIcon=()=>null, ClipboardListIcon=BotIcon, DiamondIcon=BotIcon, EditIcon=BotIcon, FileTextIcon=BotIcon, HelpCircleIcon=BotIcon, LightningIcon=BotIcon, SparklesIcon=BotIcon, StarIcon=BotIcon, TargetIcon=BotIcon;',
  };
  try {
    await esbuild.build({
      absWorkingDir: root, bundle: true, platform: 'browser', jsx: 'automatic',
      outfile: path.join(temp, 'fixture.js'),
      stdin: { resolveDir: root, loader: 'jsx', contents: `
        import React from 'react';
        import {createRoot} from 'react-dom/client';
        import AIQuickPanel from './src/ui/components/integration/AIQuickPanel';
        import {sent, saved, chatState, controls} from 'fixture-state';
        const root = createRoot(document.getElementById('root'));
        const render = () => root.render(<AIQuickPanel onClose={() => {}}/>);
        const assert = (condition, message) => {if (!condition) throw new Error(message)};
        const wait = async (predicate, message) => {
          for(let i=0;i<200;i++){if(predicate())return; await new Promise(r=>setTimeout(r,10));}
          throw new Error('Timeout: '+message);
        };
        const button = text => [...document.querySelectorAll('button')].find(b =>
          b.textContent.trim() === text || [...b.querySelectorAll('p,span')].some(el => el.textContent.trim() === text));
        const setText = (el, text) => {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text);
          el.dispatchEvent(new Event('input',{bubbles:true}));
        };
        const popup = () => document.getElementById('ai-zalo-message');
        const open = async () => {
          const input = document.querySelector('textarea[placeholder="Nhập câu hỏi..."]');
          setText(input,'Gửi hỏi giá');
          const sendButton = input.parentElement.querySelector('button');
          await wait(()=>!sendButton.disabled,'chat ready'); sendButton.click();
          await wait(popup,'popup opens');
        };
        window.runTests = async () => {
          render();
          await wait(()=>document.querySelector('textarea[placeholder="Nhập câu hỏi..."]'),'panel loaded');
          await open();
          assert(sent.length===0,'Opening popup must not send');
          assert(popup().value==='Xin giá 100 sản phẩm X','Draft from tool');
          await wait(()=>button('NCC A'),'contacts loaded'); button('NCC A').click();
          button('Nhóm').click(); await wait(()=>button('Nhóm NCC A'),'group tab loaded');
          button('Nhóm NCC A').click(); await wait(()=>button('Chạy (2)'),'cross-tab selection retained');
          setText(popup(),'Nội dung đã sửa'); await new Promise(r=>setTimeout(r,10));
          const run = button('Chạy (2)'); run.click(); run.click();
          await wait(()=>!popup(),'batch completes');
          assert(sent.length===2,'Double click sends each selected destination once');
          assert(sent[0].threadId==='user-a' && sent[1].threadId==='group-a','Send selected user and group');
          assert(sent.every(p=>p.message==='Nội dung đã sửa' && p.auth.accountId==='sender-a' && p.zaloId==='sender-a' && p.strictAccountId && p.aiChatRequestId),'Edited text, correct sender and tracking request');
          assert(sent[0].aiChatRequestId===sent[1].aiChatRequestId,'One task connects both destinations');
          assert(document.body.textContent.includes('1/2 thành công, 1 thất bại'),'Partial delivery summary');
          assert(saved.some(m=>m.content.includes('Lỗi fixture') && m.content.includes('Nội dung đã sửa')),'Persist tool outcome');
          await open(); document.querySelector('[aria-label="Đóng popup chọn người nhận"]').click();
          await wait(()=>!popup(),'cancel closes'); assert(sent.length===2,'Cancel sends nothing');
          await open(); await wait(()=>button('NCC A'),'contacts reloaded'); button('NCC A').click();
          button('Sender A').click(); await wait(()=>button('Sender B'),'sender choices');
          assert(!document.body.textContent.includes('Facebook fixture'),'Only Zalo senders shown');
          button('Sender B').click(); await wait(()=>button('Nhóm NCC B'),'new sender contacts');
          assert(!button('Chạy (1)'),'Changing sender clears old selection');
          button('Nhóm NCC B').click(); await wait(()=>button('Chạy (1)'),'new selection'); button('Chạy (1)').click();
          await wait(()=>!popup(),'new sender sends');
          assert(sent.length===3 && sent[2].auth.accountId==='sender-b' && sent[2].threadId==='group-b','Use new sender only');
          await open(); chatState.activeThreadId='thread-2'; render();
          await wait(()=>!popup(),'switching conversation discards pending popup');
          assert(sent.length===3,'Switching conversation sends nothing');
          controls.slowHistory=true; chatState.activeThreadId='thread-3'; render();
          await wait(()=>controls.resolveHistory,'history request pending');
          await open(); document.querySelector('[aria-label="Đóng popup chọn người nhận"]').click();
          await wait(()=>!popup(),'send during pending history completes');
          controls.resolveHistory(); await new Promise(r=>setTimeout(r,30));
          assert(document.body.textContent.includes('Gửi hỏi giá'),'Late history keeps new messages');
          assert(!document.body.textContent.includes('LỊCH SỬ CŨ ĐẾN MUỘN'),'Late history does not overwrite live chat');
          controls.slowHistory=false; controls.slowConversation=true;
          chatState.activeThreadId='thread-4'; render(); await new Promise(r=>setTimeout(r,20));
          await open(); document.querySelector('[aria-label="Đóng popup chọn người nhận"]').click();
          await wait(()=>!popup(),'chat works when conversation storage stalls');
          controls.slowConversation=false; chatState.activeThreadId=null; render();
          await new Promise(r=>setTimeout(r,20));
          await open(); document.querySelector('[aria-label="Đóng popup chọn người nhận"]').click();
          await wait(()=>!popup(),'chat works without an open Zalo conversation');
          const input=document.querySelector('textarea[placeholder="Nhập câu hỏi..."]');
          assert(input.value==='' && input.parentElement.querySelector('button').disabled,'Empty input alone remains disabled');
          assert(sent.length===3,'Regression scenarios do not send any real or extra messages');
          return {passed:12, messagesSentToFixtures:sent.length};
        };
      `},
      plugins: [{ name: 'isolated-fixtures', setup(build) {
        build.onResolve({filter: /.*/}, args => {
          if (args.path === 'fixture-state') return {path: statePath};
          if (Object.hasOwn(mocks, args.path)) return {path:args.path,namespace:'fixture-mock'};
          if (args.path.startsWith('@/')) return {path:path.join(root,'src/ui',args.path.slice(2)+'.ts')};
        });
        build.onLoad({filter: /.*/, namespace:'fixture-mock'}, args => ({contents:mocks[args.path],resolveDir:root,loader:'js'}));
      }}],
    });
    fs.writeFileSync(path.join(temp, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    const runner = path.join(temp, 'runner.cjs');
    fs.writeFileSync(runner, `
      const {app,BrowserWindow}=require('electron');
      app.whenReady().then(async()=>{
        const window = new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
        try {
          await window.loadFile(${JSON.stringify(path.join(temp, 'index.html'))});
          const result=await window.webContents.executeJavaScript('window.runTests()');
          console.log('PASS Chat Zalo UI:',JSON.stringify(result)); app.exit(0);
        } catch(error) {console.error(error);app.exit(1);}
      });
    `);
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [runner], {env,encoding:'utf8',windowsHide:true,timeout:60000});
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Chat Zalo UI test failed');
  } finally {
    const resolvedTemp = path.resolve(temp);
    if (path.dirname(resolvedTemp) !== path.resolve(os.tmpdir()) || !path.basename(resolvedTemp).startsWith('deplao-chat-zalo-test-')) {
      throw new Error('Unexpected test cleanup directory');
    }
    fs.rmSync(temp, {recursive:true,force:true});
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
