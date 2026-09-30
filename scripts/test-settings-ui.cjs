const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-settings-ui-"));
const watchdog = setTimeout(() => { console.error("Settings UI test timed out"); app.exit(1); }, 30000);
app.setPath("userData", path.join(temp, "user-data"));
app.whenReady().then(async () => {
  let win;
  try {
    const entry = path.join(temp, "entry.tsx");
    fs.writeFileSync(entry, `import React from 'react'; import {createRoot} from 'react-dom/client'; import {UsageSettings} from '../src/renderer/src/components/UsageSettings'; import {McpSettings} from '../src/renderer/src/components/McpSettings'; import {Sidebar} from '../src/renderer/src/components/Sidebar'; import {useStore} from '../src/renderer/src/store'; import {formatTokens} from '../src/renderer/src/lib/token-format'; window.formatTokens=formatTokens; window.testStore=useStore;const root=createRoot(document.getElementById('app')); window.showView=(view)=>{root.render(view==='usage'?<UsageSettings language="zh"/>:view==='sidebar'?<Sidebar onOpenRemote={()=>{}}/>:<McpSettings language="zh"/>)}; window.showView('usage');`);
    await esbuild.build({ entryPoints: [entry], outfile: path.join(temp, "test.js"), bundle: true, platform: "browser", loader: { ".png": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' } });
    fs.writeFileSync(path.join(temp, "index.html"), `<html><head><link rel="stylesheet" href="../src/renderer/src/styles.css"><link rel="stylesheet" href="test.css"><style>body{overflow:auto;padding:36px;background:var(--bg);color:var(--text)}#app{max-width:1080px;margin:auto}.set-card{padding:24px}</style></head><body><div id="app"></div><script>
    const now=new Date(); const days=Array.from({length:365},(_,i)=>{const d=new Date(now);d.setDate(d.getDate()-364+i);const date=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');return {date,tokens:i>150?((i*7919)%110000):0,cost:0.01,input:10,output:20,cacheRead:0,cacheWrite:0,requests:1}});
    window.savedMcp={mcpServers:{test:{command:'node',args:['test.js'],enabled:false,env:{KEY:'\${TEST_KEY}'}}}};window.saveCalls=0;
    window.pi={settings:{getUsage:async range=>({tokens:100000,input:10000,output:20000,cacheRead:70000,cacheWrite:0,cost:1,requests:100,sessions:3,unreadableFiles:0,days:days.filter(d=>+new Date(d.date+'T12:00:00')>=range.from&&+new Date(d.date+'T12:00:00')<range.to),models:[{provider:'fixture',model:'model',tokens:100000,requests:100,cost:1}]}),getMcp:async()=>({path:'test/mcp.json',config:window.savedMcp}),saveMcp:async config=>{window.savedMcp=config;window.saveCalls++;return {path:'test/mcp.json',config}},mcpAction:async()=>({code:0,stdout:'test connected: 1 tool',stderr:''})},app:{getProjects:async()=>[]}};
    const originalUsage=window.pi.settings.getUsage;
    window.pi.settings.getUsage=async range=>{window.lastUsageRange=range;const report=await originalUsage(range);return {...report,reportedCost:0,estimatedCost:1,equivalentCost:2,unpricedRequests:1,models:report.models.map(m=>({...m,input:10000,output:20000,cacheRead:70000,cacheWrite:0,pricing:[{source:'catalog',billing:'api',cost:1,equivalentCost:0,requests:100,tokens:100000,rates:{input:1,output:3,cacheRead:.1,cacheWrite:1.25},breakdown:{input:.1,output:.6,cacheRead:.3,cacheWrite:0}}]}))}};
    window.pi.settings.getPlanQuotas=async()=>[{id:'opencode-go',label:'OpenCode Go',status:'ok',fetchedAt:Date.now(),windows:[{name:'rolling',usedPercent:35,remainingPercent:65,resetsAt:'2026-10-01T00:00:00Z'},{name:'weekly',usedPercent:50,remainingPercent:50}]},{id:'kimi',label:'Kimi Code',status:'missing',message:'KIMI_CODING_API_KEY',windows:[]}];
    window.pi.settings.getUsagePricing=async()=>({snapshot:'fixture',config:{overrides:[]},catalog:[{provider:'fixture',model:'model',price:{cacheMiss:1,cacheHit:.1,output:3}}]});
    window.priceSaveCalls=0;window.pi.settings.saveUsagePricing=async config=>{window.priceSaveCalls++;return config};
    </script><script src="test.js"></script></body></html>`);
    win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(temp, "index.html"));
    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (v, message) => { if (!v) throw new Error(message); };
      const settle = () => new Promise(r => setTimeout(r, 150));
      await settle();
      assert(document.querySelector('.plan-quota-numbers').textContent.includes('65.0%'),'plan remaining quota visible');
      assert(document.querySelectorAll('.plan-quota-window').length===2,'independent rolling and weekly quota windows');
      document.querySelector('.usage-model-detail').open=true; await settle();
      assert(document.querySelector('.usage-rate-detail').textContent.includes('单价 USD / 百万 Token'),'cost formula rates visible');
      assert(document.querySelector('.usage-cost-summary').textContent.includes('订阅等值费用'),'subscription equivalents kept separate');
      const priceDetails=document.querySelector('.usage-price-settings');priceDetails.open=true;
      const priceEditor=document.querySelector('.usage-pricing-editor');const priceSetter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      priceSetter.call(priceEditor,'{broken');priceEditor.dispatchEvent(new Event('input',{bubbles:true}));await settle();
      [...priceDetails.querySelectorAll('button')].find(b=>b.textContent.includes('保存价格')).click();await settle();
      assert(window.priceSaveCalls===0 && priceDetails.querySelector('[role=alert]'),'invalid pricing JSON not saved');
      for (const [value, expected] of [[0,'0'],[999,'999'],[100000,'100K'],[1000000,'1M'],[15832753,'15.83M'],[189647273,'189.65M'],[1000000000,'1B'],[1200000000,'1.2B']]) assert(window.formatTokens(value)===expected,'token unit: '+value);
      assert(document.querySelector('.activity-totals strong').textContent==='100K','summary uses compact units');
      for (const width of [540,680,1080]) {
        document.getElementById('app').style.width=width+'px'; await settle();
        const wrapper=document.querySelector('.activity-scroll'), grid=document.querySelector('.activity-grid');
        assert(wrapper.scrollWidth<=wrapper.clientWidth+1,'heatmap must fit panel width '+width);
        assert(grid.getBoundingClientRect().right<=wrapper.getBoundingClientRect().right+1,'last calendar column remains visible '+width);
      }
      document.getElementById('app').style.width='';await settle();
      assert(document.querySelectorAll('.activity-cell:not(:disabled)').length === 365, 'year heatmap date coverage');
      const cells = [...document.querySelectorAll('.activity-cell:not(:disabled)')];
      cells[0].dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await settle();
      let tooltip=document.querySelector('[role=tooltip]');
      assert(tooltip && tooltip.textContent.includes(cells[0].getAttribute('aria-label').slice(0,10)),'hover shows the correct date');
      assert(tooltip.textContent.includes('0 tokens'),'zero usage is shown explicitly');
      assert(getComputedStyle(tooltip).pointerEvents==='none','tooltip must not intercept pointer events');
      cells[0].dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));await settle();
      assert(!document.querySelector('[role=tooltip]'),'tooltip dismisses when mouse leaves');
      cells[cells.length-1].focus({preventScroll:true});await settle();
      // Hidden offscreen windows do not emit focusin while document.hasFocus()
      // is false. Deliver the browser focus event to exercise the React handler.
      cells[cells.length-1].dispatchEvent(new FocusEvent('focusin',{bubbles:true}));await settle();
      tooltip=document.querySelector('[role=tooltip]');
      assert(tooltip && tooltip.textContent.includes(cells[cells.length-1].getAttribute('aria-label').slice(0,10)),'focus event shows the correct date');
      assert(tooltip.getBoundingClientRect().right<=innerWidth-10,'tooltip remains inside the right viewport edge');
      window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await settle();
      assert(!document.querySelector('[role=tooltip]'),'Escape dismisses the tooltip');
      cells[cells.length-1].blur();
      const green = cells.find(c => c.style.background === 'var(--accent)');
      const rgb = getComputedStyle(green).backgroundColor.match(/\d+/g).map(Number);
      assert(rgb[1] > rgb[0] && rgb[1] > rgb[2], 'heatmap follows green theme accent');
      document.querySelectorAll('.activity-modes button')[1].click(); await settle();
      assert(document.querySelectorAll('.activity-modes button')[1].getAttribute('aria-pressed') === 'true', 'weekly view switches');
      document.querySelectorAll('.activity-modes button')[2].click(); await settle();
      assert(document.querySelectorAll('.activity-modes button')[2].getAttribute('aria-pressed') === 'true', 'cumulative view switches');
      const store = window.testStore;
      store.setState({threads:{qa:{cwd:'.',sessionFile:null,sessionName:null,model:null,models:[],thinking:'off',levels:[],commands:[],isStreaming:false,messages:[],streaming:null,toolRuns:{parent:{id:'parent',name:'codemode',args:{},running:true}},permission:'sandbox'}}});
      store.getState().handleEvent('qa',{type:'tool_execution_start',toolCallId:'parent/0',parentToolCallId:'parent',toolName:'mcp__test__echo',args:{text:'a'}});
      store.getState().handleEvent('qa',{type:'tool_execution_end',toolCallId:'parent/0',parentToolCallId:'parent',toolName:'mcp__test__echo',isError:false,result:{content:[]}});
      await settle();
      assert(store.getState().threads.qa.toolRuns.parent.nestedCalls.calls[0].status === 'ok','nested tool lifecycle');
      assert(Object.keys(store.getState().threads.qa.toolRuns).length===1,'nested call must not create independent assistant tool blocks');
      store.getState().handleExtUi('qa',{method:'setStatus',statusKey:'mcp',statusText:'Connected'});
      store.getState().handleExtUi('qa',{method:'setWidget',widgetKey:'progress',widgetLines:['Ready'],widgetPlacement:'belowEditor'});
      assert(store.getState().threads.qa.extensionStatuses.mcp==='Connected','extension status updates');
      assert(store.getState().threads.qa.extensionWidgets.progress.placement==='belowEditor','extension widget placement');
      store.getState().handleExtUi('qa',{method:'setStatus',statusKey:'mcp'});
      assert(!store.getState().threads.qa.extensionStatuses.mcp,'extension status removal');
      return 'Green heatmap, daily/weekly/cumulative views, nested tool events and extension UI passed';
    }} )()`);
    fs.writeFileSync(path.join(root, "qa-token-activity-light.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(root, "qa-token-activity-dark.png"), (await win.webContents.capturePage()).toPNG());
    const mcp = await win.webContents.executeJavaScript(`(${async function () {
      const assert=(v,m)=>{if(!v)throw new Error(m)};const settle=()=>new Promise(r=>setTimeout(r,150));
      window.testStore.setState({config:{language:'zh'},sidebarOpen:true});window.showView('sidebar');await settle();
      document.querySelector('button[title="最近 24 小时用量"]').click();await settle();
      assert(window.lastUsageRange.to-window.lastUsageRange.from===86400000,'sidebar uses rolling 24 hours');
      assert(Math.abs(Date.now()-window.lastUsageRange.to)<1000,'sidebar range ends now');
      assert(document.querySelector('.usage-pop-head').textContent.includes('最近 24 小时'),'sidebar period label');
      assert(document.querySelector('.usage-cost').textContent.includes('API 估算费用'),'sidebar uses calculated API cost');
      window.showView('mcp');await settle();
      document.querySelector('input[type=checkbox]').click();await settle();
      assert(window.savedMcp.mcpServers.test.enabled===true,'enable persists');
      assert(window.savedMcp.mcpServers.test.env.KEY==='${TEST_KEY}','enable preserves server secrets references');
      [...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加 / 编辑')).click();await settle();
      const editor=document.querySelector('textarea');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(editor,'{broken');editor.dispatchEvent(new Event('input',{bubbles:true}));await settle();
      const calls=window.saveCalls;[...document.querySelectorAll('button')].find(b=>b.textContent.includes('保存配置')).click();await settle();
      assert(window.saveCalls===calls,'invalid JSON is not saved');assert(document.querySelector('[role=alert]'),'invalid JSON error visible');
      return 'MCP UI enable/preservation/invalid editor passed';
    }})()`);
    console.log(result); console.log(mcp);
    app.exit(0);
  } catch (e) { console.error(e); app.exit(1); }
  finally { clearTimeout(watchdog); if (win && !win.isDestroyed()) win.destroy(); try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Electron may retain shader cache locks until the process exits on Windows. */ } }
});
