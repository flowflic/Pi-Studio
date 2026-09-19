import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolveSkillsCliPath } from "../src/main/skills-cli-path.ts";

const require = createRequire(import.meta.url);
const root = mkdtempSync(join(tmpdir(), "pi skills test "));
try {
  const devCli = require.resolve("skills/bin/cli.mjs");
  assert.equal(resolveSkillsCliPath(devCli), devCli);
  assert.throws(() => resolveSkillsCliPath(join(root, "missing.mjs")), /bundled skills CLI is unavailable/);
  const virtual = join(root, "app.asar", "node_modules", "skills", "bin", "cli.mjs");
  const unpacked = join(root, "app.asar.unpacked", "node_modules", "skills", "bin", "cli.mjs");
  mkdirSync(join(unpacked, ".."), { recursive: true });
  writeFileSync(unpacked, "");
  assert.equal(resolveSkillsCliPath(virtual), unpacked);
  assert.equal(resolveSkillsCliPath(virtual.replaceAll("\\", "/")), unpacked.replaceAll("\\", "/"));

  // Optional real electron-builder output validates unpacking and transitive imports.
  const cli = process.argv[2]
    ? resolveSkillsCliPath(join(resolve(process.argv[2]), "app.asar", "node_modules", "skills", "bin", "cli.mjs"))
    : devCli;
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, ".pi", "agent"), DISABLE_TELEMETRY: "1", CI: "1" };
  const run = (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run(["--help"]);
  const fixture = join(root, "fixture");
  mkdirSync(fixture);
  const markdown = "---\nname: pi-hub-regression\ndescription: Offline installation regression fixture\n---\nTest skill.\n";
  writeFileSync(join(fixture, "SKILL.md"), markdown);
  run(["add", fixture, "--skill", "pi-hub-regression", "--agent", "pi", "--global", "--yes", "--copy"]);
  assert.equal(readFileSync(join(root, ".pi", "agent", "skills", "pi-hub-regression", "SKILL.md"), "utf8"), markdown);
  console.log("Skills CLI path, startup and isolated offline installation passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
