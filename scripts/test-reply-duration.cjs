const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-reply-duration-"));
app.setPath("userData", path.join(temp, "user-data"));
const watchdog = setTimeout(() => { console.error("Reply duration test timed out"); app.exit(1); }, 30000);
function loadModule(relative) {
  const file = path.join(root, relative);
  const api = {};
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: 9, module: 1 } }).outputText;
  new Function("require", "exports", source)(name => name === "./reply-timing" ? loadModule("src/main/reply-timing.ts") : require(name), api);
  return api;
}
app.whenReady().then(async () => {
  let win;
  try {
    const file = path.join(temp, "session.jsonl");
    const timing = { type: "custom", customType: "pi-studio-reply-timing", data: { entryIds: ["a1", "a2"], startedAt: 10000, endedAt: 74000 } };
    fs.writeFileSync(file, [
      { type: "message", id: "u", message: { role: "user", content: "Hi" } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Thinking" }] } },
      { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }, timing,
    ].map(e => JSON.stringify(e)).join("\n"));
    const history = await loadModule("src/main/session-store.ts").readThreadHistory(file);
    assert.equal(history.branchMessages[1].replyStartedAt, 10000);
    assert.equal(history.branchMessages[2].replyEndedAt, 74000);
    assert.equal(history.messages.length, 3, "timing does not enter model messages");
    assert.equal(loadModule("src/main/reply-timing.ts").replyTimings([{ ...timing, data: { ...timing.data, endedAt: -1 } }]).size, 0);
    fs.writeFileSync(path.join(temp, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import {Chat} from '../src/renderer/src/components/Chat';import {useStore} from '../src/renderer/src/store';import {formatReplyDuration} from '../src/renderer/src/components/ReplyDuration';window.store=useStore;window.formatDuration=formatReplyDuration;const thread={cwd:'fixture',sessionFile:'a',model:null,models:[],thinking:'off',levels:['off'],commands:[],connected:true,isStreaming:false,messages:[],streaming:null,toolRuns:{},permission:'sandbox'};useStore.setState({activeThreadId:'a',config:{language:'zh'},projects:[],threads:{a:{...thread},b:{...thread,sessionFile:'b'}}});createRoot(document.getElementById('app')).render(<Chat/>);`);
    await esbuild.build({ entryPoints: [path.join(temp, "entry.tsx")], outfile: path.join(temp, "test.js"), bundle: true, platform: "browser", loader: { ".png": "dataurl" }, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
    fs.writeFileSync(path.join(temp, "index.html"), `<html><head><meta charset="UTF-8"><link rel="stylesheet" href="../src/renderer/src/styles.css"></head><body><div id="app" style="height:100vh"></div><script>window.historyFixture=${JSON.stringify(history)};window.pi={thread:{getBranchMessages:async()=>({messages:[]}),getThinkingLevels:async()=>({levels:['off']}),loadHistory:async()=>({...window.historyFixture,sessionFile:'reopened',connected:true})},app:{fileExists:async()=>true,getProjects:async()=>[]}};</script><script src="test.js"></script></body></html>`);
    win = new BrowserWindow({ width: 950, height: 700, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(temp, "index.html"));
    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
      const store = window.store;
      const event = async e => { store.getState().handleEvent('a', e); await settle(); };
      const label = () => document.querySelector('.reply-duration')?.textContent;
      assert(window.formatDuration(64000,'zh')==='1 分 4 秒','minute formatting');
      assert(window.formatDuration(3661000,'en')==='1h 1m 1s','hour formatting');
      await event({type:'agent_start'});
      assert(label()?.includes('用时'),'timer visible before first token');
      const start = store.getState().threads.a.replyStartedAt;
      await event({type:'message_start',message:{role:'assistant'}});
      await event({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Calling tool'}],stopReason:'toolUse'}});
      assert(document.querySelector('.reply-duration[data-running]'),'timer remains live between model calls');
      const before = label(); await settle(1200);
      assert(label()!==before,'timer updates while tools execute');
      await event({type:'agent_start'});
      assert(store.getState().threads.a.replyStartedAt===start,'retry does not reset reply duration');
      store.setState({activeThreadId:'b'}); await settle();
      assert(!document.querySelector('.reply-duration'),'thread B has no A timer');
      await settle(1100); store.setState({activeThreadId:'a'}); await settle();
      assert(document.querySelector('.reply-duration[data-running]'),'switching back resumes elapsed time');
      await event({type:'message_start',message:{role:'assistant'}});
      await event({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Done'}],stopReason:'stop'}});
      await event({type:'agent_settled'});
      assert(document.querySelectorAll('.reply-duration').length===1,'one timer per reply, not per model call');
      const final = label(); await settle(1200);
      assert(label()===final && !document.querySelector('.reply-duration[data-running]'),'final duration freezes');
      assert(store.getState().threads.a.messages.every(m=>m.replyEndedAt>=start),'all assistant messages finalized');
      await event({type:'message_start',message:{role:'user',content:'Again'}});
      await event({type:'agent_start'});
      assert(document.querySelectorAll('.reply-duration').length===2,'next reply gets independent timer');
      store.getState().handleExit('a',{code:1}); await settle();
      assert(!document.querySelector('.reply-duration[data-running]'),'process exit stops timer');
      await store.getState().openThread('fixture','reopened'); await settle();
      assert(label()==='用时 1 分 4 秒','reopened transcript displays persisted final duration');
      window.historyFixture={messages:[{role:'user',content:'Active'}, {role:'assistant',content:[{type:'text',text:'Running tool'}]}],isStreaming:true,replyStartedAt:Date.now()-10000};
      window.pi.thread.loadHistory=async()=>({...window.historyFixture,sessionFile:'live-reopened',connected:true});
      await store.getState().openThread('fixture','live-reopened'); await settle();
      assert(label()==='用时 10 秒' && document.querySelector('.reply-duration[data-running]'),'reopening a live reply keeps original start time');
      const activeId = store.getState().activeThreadId;
      const startAt = Date.now() - 5000;
      const deliveryMessages = [
        {key:'delivery-call',role:'assistant',replyStartedAt:startAt,blocks:[{type:'toolCall',id:'write-script',name:'write',arguments:{path:'build.py'}},{type:'toolCall',id:'present',name:'pi_studio_present',arguments:{files:[{path:'report.xlsx'}]}}],stopReason:'toolUse'},
        {key:'delivery-final',role:'assistant',replyStartedAt:startAt,blocks:[{type:'text',text:'Final report is ready.'}],stopReason:'stop'},
      ];
      const toolRuns = {'write-script':{id:'write-script',name:'write',args:{path:'build.py'},completed:true,running:false},present:{id:'present',name:'pi_studio_present',args:{},completed:true,running:false,resultText:JSON.stringify({kind:'pi-studio-deliverables',version:1,files:[{path:'report.xlsx',description:'Final report'}]})}};
      const setDelivery = async patch => { store.setState(s=>({threads:{...s.threads,[activeId]:{...s.threads[activeId],...patch}}})); await settle(); };
      await setDelivery({messages:deliveryMessages,toolRuns,isStreaming:true,replyStartedAt:startAt});
      assert(!document.querySelector('.msg-artifacts'),'deliveries hidden while reply streams');
      await setDelivery({isStreaming:false,replyStartedAt:undefined,messages:deliveryMessages.map(m=>({...m,replyEndedAt:Date.now()}))});
      assert(document.querySelectorAll('.msg-artifact').length===1,'one final delivery, no intermediate script');
      assert(document.querySelector('.msg-artifacts').textContent.includes('report.xlsx'),'final report displayed');
      assert(document.querySelector('.msg-artifact-copy').textContent.includes('Final report'),'delivery description displayed');
      const body = document.querySelector('.msg.assistant .msg-body');
      assert(body.textContent.indexOf('Final report is ready.')<body.textContent.indexOf('最终产物'),'delivery follows final response');
      await setDelivery({messages:[deliveryMessages[0],{...deliveryMessages[1],errorMessage:'Cancelled',stopReason:'aborted'}]});
      assert(!document.querySelector('.msg-artifacts'),'cancelled reply does not present completed deliverables');
      window.pi.app.fileExists=async()=>false;
      await setDelivery({messages:deliveryMessages,toolRuns:{...toolRuns,present:{...toolRuns.present,resultText:JSON.stringify({kind:'pi-studio-deliverables',version:1,files:[{path:'deleted.xlsx'}]})}}});
      assert(!document.querySelector('.msg-artifacts'),'deleted deliverable excluded after existence probe');
      return 'Reply duration and final delivery UI passed: streaming visibility, final placement, intermediate filtering, descriptions, cancellation, deleted files and persisted history.';
    }.toString()})()`);
    console.log(result);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog);
    if (win) win.destroy();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Chromium cache may still be locked. */ }
    app.exit(process.exitCode || 0);
  }
});
