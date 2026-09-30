const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function load(relative) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, relative), "utf8"), { compilerOptions: { target: 9, module: 1 } }).outputText;
  const api = {};
  new Function("require", "exports", source)(require, api);
  return api;
}
(async () => {
  const { selectFinalArtifacts, resolveArtifactPath } = load("src/renderer/src/lib/artifacts.ts");
  const temp = fs.mkdtempSync(path.join(root, ".tmp-deliverables-"));
  try {
    let tool;
    load("src/main/permission-gate-ext.ts").default({ registerTool: value => tool = value, registerCommand() {}, on() {} });
    fs.writeFileSync(path.join(temp, "final report.xlsx"), "fixture");
    const execute = files => tool.execute("call", { files }, undefined, undefined, { cwd: temp });
    const result = await execute([{ path: "final report.xlsx", description: "Final workbook" }, { path: "./final report.xlsx" }]);
    assert.equal(result.details.files.length, 1, "duplicate declarations collapse");
    assert.equal(result.details.files[0].path, path.join(temp, "final report.xlsx"));
    await assert.rejects(execute([{ path: "missing.xlsx" }]), /file not found/);
    await assert.rejects(execute([{ path: "." }]), /not a regular file/);
    await assert.rejects(execute([{ path: "final report.xlsx" }, { path: "missing.xlsx" }]), /file not found/, "all paths validate atomically");
    await assert.rejects(execute([]), /1 to 20/);
    const signal = AbortSignal.abort();
    await assert.rejects(tool.execute("abort", { files: [{ path: "final report.xlsx" }] }, signal, undefined, { cwd: temp }));
    const runs = {};
    const blocks = [];
    const call = (id, name, args, text, flags = {}) => {
      blocks.push({ type: "toolCall", id, name, arguments: args });
      runs[id] = { id, name, args, completed: true, running: false, resultText: text, ...flags };
    };
    call("script", "write", { path: "build.py" });
    call("qa", "bash", {}, "Output: qa.png\nOutput: final report.xlsx");
    const final = { key: "final", role: "assistant", blocks: [{ type: "text", text: "Ready [report](<final report.xlsx>)" }], stopReason: "stop" };
    const messages = [{ key: "tools", role: "assistant", blocks }, final];
    assert.deepEqual(selectFinalArtifacts(messages, runs, temp).map(f => f.name), ["final report.xlsx"], "legacy final references exclude scripts and QA files");
    final.blocks[0].text = "Done";
    assert.equal(selectFinalArtifacts(messages, runs, temp).length, 0, "changed files alone are not final deliveries");
    const present = files => JSON.stringify({ kind: "pi-studio-deliverables", version: 1, files });
    call("p1", "pi_studio_present", {}, present([{ path: "draft.xlsx" }]));
    call("p2", "pi_studio_present", {}, result.content[0].text);
    call("failed", "pi_studio_present", {}, present([{ path: "missing.xlsx" }]), { isError: true });
    call("pending", "pi_studio_present", {}, present([{ path: "running.xlsx" }]), { running: true, completed: false });
    assert.deepEqual(selectFinalArtifacts(messages, runs, temp).map(f => f.name), ["final report.xlsx"], "last successful presentation wins");
    assert.equal(selectFinalArtifacts(messages, runs, temp)[0].description, "Final workbook");
    assert.deepEqual(selectFinalArtifacts(JSON.parse(JSON.stringify(messages)), JSON.parse(JSON.stringify(runs)), temp), selectFinalArtifacts(messages, runs, temp), "reloaded transcript has identical delivery selection");
    assert.equal(selectFinalArtifacts([{ role: "assistant", blocks: [{ type: "text", text: "[report](final%20report.xlsx)" }] }], runs, temp).length, 0, "references to previous rounds do not leak");
    assert.equal(resolveArtifactPath("\\\\server\\share\\report.xlsx", temp), "//server/share/report.xlsx");
    console.log("Final deliverable selection, legacy references, replacement, persistence, existence and cancellation passed");
  } finally {
    assert.ok(temp.startsWith(root + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
