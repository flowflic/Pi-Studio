const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const XLSX = require("xlsx");
const JSZip = require("jszip");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-office-preview-"));
app.setPath("userData", path.join(temp, "user-data"));
const watchdog = setTimeout(() => { console.error("Office preview test timed out"); app.exit(1); }, 60000);

async function fixtures() {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["Monthly report"], ["Item", "Count", "Total"], ["Camera", 1250, { t: "n", v: 2500, f: "B3*2" }], ["Ratio", { t: "n", v: 0.125, z: "0.0%" }, "<img src=x onerror=alert(1)>"]]);
  sheet["!merges"] = [XLSX.utils.decode_range("A1:C1")];
  sheet["!cols"] = [{ wpx: 200 }, { wpx: 125 }, { wpx: 160 }];
  sheet["!rows"] = [{ hpx: 40 }];
  XLSX.utils.book_append_sheet(wb, sheet, "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Details", "Value"], ["Other", 42]]), "Details");
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  zip.file("xl/styles.xml", `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2E7D52"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="thin"><color rgb="FF226644"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`);
  let sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  for (const [address, style] of [["A1", 1], ["B4", 2], ["C3", 3]]) sheetXml = sheetXml.replace(new RegExp(`<c r="${address}"[^>]*>`), m => m.replace(/ s="\d+"/, "").replace(/>$/, ` s="${style}">`));
  sheetXml = sheetXml.replace(/<sheetViews>.*?<\/sheetViews>/s, `<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews>`);
  sheetXml = sheetXml.replace("</worksheet>", '<drawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId99"/></worksheet>');
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  const doc = new JSZip();
  doc.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  doc.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  doc.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  doc.file("word/header1.xml", '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Report header</w:t></w:r></w:p></w:hdr>');
  doc.file("word/footer1.xml", '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Report footer</w:t></w:r></w:p></w:ftr>');
  doc.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="2E7D52"/></w:rPr><w:t>Quarterly report</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Camera</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1250</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/><w:t>Second page</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`);
  return { xlsx: await zip.generateAsync({ type: "base64" }), xls: XLSX.write(wb, { type: "base64", bookType: "biff8" }), docx: await doc.generateAsync({ type: "base64" }) };
}

app.whenReady().then(async () => {
  let win;
  try {
    const data = await fixtures();
    fs.writeFileSync(path.join(temp, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import Sheet,{createSpreadsheetPreview} from '../src/renderer/src/components/SpreadsheetPreview';import Doc from '../src/renderer/src/components/DocumentPreview';import {loadOfficeWorkbook} from '../src/renderer/src/lib/office-workbook';const root=createRoot(document.getElementById('app'));window.officeTools={loadOfficeWorkbook,createSpreadsheetPreview};window.showOffice=(kind,opts={})=>root.render(kind==='sheet'?<Sheet base64={window.fixtures.xlsx} name="Report.xlsx" language="zh" {...opts}/>:kind==='doc'?<Doc base64={window.fixtures.docx} language="zh" {...opts}/>:null);`);
    await esbuild.build({ entryPoints: [path.join(temp, "entry.tsx")], outfile: path.join(temp, "test.js"), bundle: true, platform: "browser", define: { "process.env.NODE_ENV": '"production"' } });
    fs.writeFileSync(path.join(temp, "index.html"), `<html><head><meta charset="UTF-8"><link rel="stylesheet" href="../src/renderer/src/styles.css"><link rel="stylesheet" href="test.css"><style>body{background:var(--bg);color:var(--text)}#app{position:absolute;inset:12px;overflow:hidden}#manual{position:absolute;inset:12px}</style></head><body><div id="app"></div><script>window.fixtures=${JSON.stringify(data)}</script><script src="test.js"></script></body></html>`);
    win = new BrowserWindow({ width: 1000, height: 750, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    const consoleErrors = [];
    win.webContents.on("console-message", (_e, level, message) => { if (level === 3) { consoleErrors.push(message); console.error(message); } });
    await win.loadFile(path.join(temp, "index.html"));
    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (v, message) => { if (!v) throw new Error(message); };
      const sleep = () => new Promise(r => setTimeout(r, 100));
      const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(); } throw new Error('Office preview did not settle: '+document.body.innerText); };
      const loaded = await window.officeTools.loadOfficeWorkbook({base64:window.fixtures.xlsx,name:'Report.xlsx',language:'zh'});
      const data=loaded.workbook, sheet=data.sheets[data.sheetOrder[0]];
      assert(data.sheetOrder.length===2,'multiple sheets');
      assert(sheet.cellData[2][2].v===2500&&sheet.cellData[2][2].f==='=B3*2','cached formula and expression preserved');
      assert(sheet.cellData[3][2].v.includes('<img'),'HTML-like cell value stays literal');
      assert(sheet.mergeData[0].endColumn===2,'merged header');
      const style=data.styles[sheet.cellData[0][0].s];
      assert(style.bl===1&&style.fs===18&&style.bg.rgb==='#2E7D52'&&style.ht===2&&style.bd.b.s===1,'font, fill, alignment and border preserved');
      assert(data.styles[sheet.cellData[3][1].s].n.pattern==='0.0%','number format');
      assert(Math.abs(sheet.columnData[0].w-200)<10&&sheet.rowData[0].h===40,'row height and column width');
      assert(sheet.freeze.xSplit===1&&sheet.freeze.ySplit===2,'frozen rows and columns');
      assert(loaded.unsupported,'drawings are disclosed');
      const legacy=await window.officeTools.loadOfficeWorkbook({base64:window.fixtures.xls});assert(legacy.workbook.sheetOrder.length===2,'legacy XLS remains supported');
      const csv=await window.officeTools.loadOfficeWorkbook({text:'Name,Value\nExample,42'});assert(csv.workbook.sheets[csv.workbook.sheetOrder[0]].cellData[1][1].v===42,'CSV import');
      const remote=await window.officeTools.loadOfficeWorkbook({text:JSON.stringify({format:'pi-studio-xlsx-v1',sheets:[{name:'Remote',rows:[['A','B'],['camera','12']]}]})});assert(remote.workbook.sheets[remote.workbook.sheetOrder[0]].cellData[1][0].v==='camera','remote snapshot');
      const aborted=new AbortController();aborted.abort();let abortRejected=false;try{await window.officeTools.createSpreadsheetPreview(document.createElement('div'),data,'zh',aborted.signal);}catch(e){abortRejected=e.name==='AbortError';}assert(abortRejected,'cancelled previews do not mount');
      const host=document.createElement('div');host.id='manual';document.body.appendChild(host);
      const runtime=await window.officeTools.createSpreadsheetPreview(host,data,'zh');
      assert(!runtime.workbook.getWorkbookPermission().canEdit(),'workbook is read-only');
      const s=runtime.workbook.getSheetByName('Summary');assert(s.getRange('C3').getRawValue()===2500&&s.getRange('C3').getValue()==='2,500.00','saved formula result and formatted display retained');
      s.zoom(1.5);await sleep();assert(s.getZoom()===1.5,'zoom works in viewer mode: '+s.getZoom());
      runtime.univer.dispose();host.remove();
      window.showOffice('sheet');await sleep();await wait(()=>document.querySelector('.office-sheet-preview')&&!document.querySelector('.office-preview-overlay'));
      assert(Array.from(document.querySelectorAll('canvas')).some(c=>c.width>0&&c.height>0),'Univer draws spreadsheet canvas');
      assert(document.body.innerText.includes('Summary')&&document.body.innerText.includes('Details'),'sheet tabs rendered');
      assert(document.querySelector('.office-preview-readonly').innerText.includes('只读'),'localized read-only label');
      assert(!document.querySelector('.office-preview-error'),'sheet renders successfully');
      const select=document.querySelector('select');select.value='150';select.dispatchEvent(new Event('change',{bubbles:true}));await sleep();assert(select.value==='150','zoom control');
      const lightBackground=getComputedStyle(document.querySelector('[data-u-comp="workbench-layout"]')).backgroundColor;
      document.documentElement.dataset.theme='dark';await sleep();
      assert(document.querySelector('[data-u-comp="workbench-layout"]').classList.contains('univer-dark'),'dark theme applied');
      assert(getComputedStyle(document.querySelector('[data-u-comp="workbench-layout"]')).backgroundColor!==lightBackground,'dark canvas chrome changes color');
      const summary=document.querySelector('[data-id="sheet-0"]');summary.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await sleep();assert(document.querySelector('[data-id="sheet-1"]').getAttribute('aria-selected')==='true'&&document.querySelector('select').value==='100','keyboard sheet switch updates selection and zoom');
      window.showOffice('sheet',{base64:undefined,text:'Name,Value\nReplacement,73'});await sleep();await wait(()=>!document.querySelector('.office-preview-overlay'));
      assert(document.querySelectorAll('.office-univer-host').length===1,'file replacement disposes old host');
      window.showOffice('doc');await sleep();await wait(()=>document.querySelector('.office-document-preview')&&!document.querySelector('.office-preview-overlay'));
      const docHost=document.querySelector('.office-doc-pages'), shadow=docHost.shadowRoot;
      assert(shadow.querySelectorAll('section.docx').length===2,'Word page breaks rendered');
      assert(shadow.textContent.includes('Report header')&&shadow.textContent.includes('Report footer'),'Word headers and footers');
      assert(shadow.querySelector('table'),'Word table rendered');
      const page=shadow.querySelector('section.docx');assert(page.offsetWidth>700,'Word page geometry retained');
      assert(parseFloat(getComputedStyle(docHost).zoom)<1.25,'fit width');
      const docZoom=document.querySelector('select');docZoom.value='75';docZoom.dispatchEvent(new Event('change',{bubbles:true}));await sleep();
      assert(document.querySelector('.office-doc-pages')===docHost,'zoom does not reparse Word');
      assert(Math.abs(parseFloat(getComputedStyle(docHost).zoom)-0.75)<0.01,'Word zoom applied');
      window.showOffice('sheet',{base64:'not base64'});await wait(()=>document.querySelector('[role=alert]'));assert(document.querySelector('[role=alert]').innerText.length,'invalid file shows error');
      // Start imports then replace before they settle: no stale content survives.
      window.showOffice('sheet');await sleep();window.showOffice('doc');await sleep();await wait(()=>document.querySelector('.office-document-preview')&&!document.querySelector('.office-preview-overlay'));
      assert(!document.querySelector('.office-univer-host')&&document.querySelector('.office-doc-pages'),'switch to Word cleans up Univer');
      return 'Office adapter/style/formula/freeze/XLS/CSV/remote, Univer read-only/zoom/theme/lifecycle, Word pages/header/footer/table/zoom and invalid-file checks passed';
    }.toString()})()`);
    assert.equal(consoleErrors.length, 0, consoleErrors.join("\n"));
    console.log(result);
    await win.webContents.executeJavaScript("window.showOffice('sheet')");
    await new Promise(resolve => setTimeout(resolve, 800));
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='light'");
    await new Promise(resolve => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(root, "qa-office-sheet.png"), (await win.webContents.capturePage()).toPNG());
    for (const width of [420, 320, 1000]) {
      win.setBounds({ width, height: 750 });
      await new Promise(resolve => setTimeout(resolve, 200));
      const layout = await win.webContents.executeJavaScript(`(()=>{const c=Array.from(document.querySelectorAll('canvas')).find(c=>c.width>0&&c.height>0&&c.closest('[data-u-comp="editor"]')===null);return {outer:document.querySelector('.office-sheet-preview').getBoundingClientRect().width,host:document.querySelector('.office-sheet-stage').clientWidth,canvas:c?.getBoundingClientRect().width,tabs:document.body.innerText.includes('Summary')};})()`);
      assert.ok(layout.canvas > 0 && layout.canvas <= layout.host + 2 && layout.tabs, `Univer resizes in ${width}px preview: ${JSON.stringify(layout)}`);
    }
    await win.webContents.executeJavaScript("window.showOffice('doc')");
    await new Promise(resolve => setTimeout(resolve, 500));
    win.setBounds({ width: 420, height: 750 });
    await new Promise(resolve => setTimeout(resolve, 200));
    const fitted = await win.webContents.executeJavaScript("(()=>{const s=document.querySelector('.office-document-stage');return {scroll:s.scrollWidth,width:s.clientWidth};})()");
    assert.ok(fitted.scroll <= fitted.width + 2, "Word fit-to-width avoids horizontal scrolling in a narrow preview");
    fs.writeFileSync(path.join(root, "qa-office-word.png"), (await win.webContents.capturePage()).toPNG());
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    clearTimeout(watchdog); win?.destroy();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* Chromium cache may retain locks until exit. */ }
    app.exit(process.exitCode || 0);
  }
});
