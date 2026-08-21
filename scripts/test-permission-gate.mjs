import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const gateModule = await import(`${pathToFileURL(resolve("src/main/permission-gate-ext.ts")).href}?test=${Date.now()}`);
const { classifyShellCommand, isOutsideProject, parseShellCommand, default: installGate } = gateModule;

const allow = [
  "Get-ChildItem | Select-Object Name,Length",
  'rg -n "sandbox" src | Select-Object -First 20',
  "git status --short",
  "git branch --show-current",
  "Get-Item package.json",
  "npm --version",
  'rg "rm|rmdir|git push" src',
];
for (const command of allow) {
  assert.equal(classifyShellCommand(command).risk, "allow", `expected read-only allow: ${command}`);
}

const allowProjectOperations = [
  "npm run build",
  "npm run typecheck",
  "npm run test -- --runInBand",
  "python build_dashboard.py",
  "node scripts/build.js",
  "Set-Content output.txt ok",
  "Set-Content -Path src/generated.css -Value body",
  "Set-Content ../outside.txt ok",
  "Copy-Item src/input.txt dist/output.txt",
  "echo built > dist/status.txt",
  "Remove-Item output.xlsx",
];
for (const command of allowProjectOperations) {
  assert.equal(classifyShellCommand(command).risk, "allow", `expected low-risk project operation to auto-allow: ${command}`);
}

const approval = [
  "npm install",
  "npm run clean",
  "python dangerous.py",
  "node scripts/clean.js",
  "some-unknown-command --flag",
  "curl https://example.com/data.json",
];
for (const command of approval) {
  assert.equal(classifyShellCommand(command).risk, "approval", `expected approval: ${command}`);
}

const always = [
  "rm -rf build",
  "rm .",
  "Remove-Item -Recurse dist",
  "rmdir dist",
  "rm ../outside.txt",
  "Set-Content .env ok",
  "Set-Content .git/config ok",
  "echo token > .env.local",
  "node ../outside.js",
  "node scripts/build.js ../outside.txt",
  "node scripts/build.js --output=../outside.txt",
  "git reset --hard HEAD~1",
  "git push origin main",
  "npm publish",
  "curl -X POST https://example.com -d value=1",
  "powershell.exe -EncodedCommand ZQBjAGgAbwA=",
  "echo $(whoami)",
  'bash -c "rm -rf build"',
  'node -e "require(\\"fs\\").rmSync(\\"build\\")"',
];
for (const command of always) {
  assert.equal(classifyShellCommand(command).risk, "always", `expected non-cacheable approval: ${command}`);
}

const inlinePython = classifyShellCommand('python -c "print(123)"');
assert.match(inlinePython.reason, /Inline Python/i);
assert.match(inlinePython.reasonZh, /内联 Python/);
assert.doesNotMatch(inlinePython.reason, /Destructive, privileged, system/i);

const deleteCommand = classifyShellCommand("Remove-Item output.xlsx");
assert.equal(deleteCommand.risk, "allow", "a single project-local file deletion should be auto-allowed");

const multiline = "ls\npython dangerous.py";
assert.deepEqual(parseShellCommand(multiline).segments, ["ls", "python dangerous.py"]);
assert.equal(classifyShellCommand(multiline).risk, "approval", "multiline command must not inherit the first command's read-only status");

assert.equal(isOutsideProject("src/main/index.ts", process.cwd()), false);
assert.equal(isOutsideProject("../outside.txt", process.cwd()), true);

function makeHarness(selectChoice) {
  let handler;
  let selectCalls = 0;
  const pi = {
    on(name, callback) {
      if (name === "tool_call") handler = callback;
    },
    registerCommand() {},
  };
  installGate(pi);
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      async select(title, options) {
        selectCalls++;
        return selectChoice(title, options, selectCalls);
      },
    },
  };
  return {
    call: (toolName, input) => handler({ toolName, input }, ctx),
    calls: () => selectCalls,
  };
}

const exact = makeHarness((_title, options) => options.find((option) => option.startsWith("Allow this exact")));
await exact.call("bash", { command: "npm install" });
await exact.call("bash", { command: "npm install" });
assert.equal(exact.calls(), 1, "exact command approval should be remembered for the thread");

const prefix = makeHarness((_title, options) => options.find((option) => option.startsWith("Allow prefix")));
await prefix.call("bash", { command: "npm run clean -- --cache" });
await prefix.call("bash", { command: "npm run clean -- --force" });
assert.equal(prefix.calls(), 1, "approved project command prefix should be remembered for the thread");

const destructive = makeHarness((_title, options) => options[0]);
await destructive.call("bash", { command: "rm -rf build" });
await destructive.call("bash", { command: "rm -rf build" });
assert.equal(destructive.calls(), 2, "destructive operations must never be cached");

const fileBoundary = makeHarness((_title, options) => options[0]);
await fileBoundary.call("write", { path: "src/generated.ts", content: "export {}" });
assert.equal(fileBoundary.calls(), 0, "project-local write should not require approval");
await fileBoundary.call("write", { path: "../outside.txt", content: "outside" });
assert.equal(fileBoundary.calls(), 0, "an explicit non-sensitive external write should not require approval");
await fileBoundary.call("edit", { path: ".env", oldText: "x", newText: "y" });
await fileBoundary.call("edit", { path: ".git/config", oldText: "x", newText: "y" });
await fileBoundary.call("write", { content: "missing path" });
assert.equal(fileBoundary.calls(), 3, "sensitive and unverifiable file changes must require fallback approval");

const extensionTool = makeHarness((_title, options) => options.find((option) => option.startsWith("Allow tool")));
await extensionTool.call("custom_lookup", { query: "one" });
await extensionTool.call("custom_lookup", { query: "two" });
assert.equal(extensionTool.calls(), 1, "an explicitly approved unknown extension tool should be remembered");

const subagent = makeHarness((_title, options) => options[0]);
await subagent.call("run_subagent", { task: "inspect" });
await subagent.call("run_subagent", { task: "inspect again" });
await subagent.call("convene_council", { task: "review" });
assert.equal(subagent.calls(), 3, "subagent full-permission escalation must never be cached");

console.log("permission gate tests passed");
