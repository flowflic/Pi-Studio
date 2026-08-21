import assert from "node:assert/strict";
import { parseHtmlReferenceText } from "../src/renderer/src/lib/html-reference.ts";

const tick = String.fromCharCode(96);
const newline = String.fromCharCode(10);
const serialized = [
  "修改文案为 Usable Test",
  "",
  "[Selected HTML element]",
  "Please modify this element:",
  `- selector: ${tick}body > h3${tick}`,
  "- tag: <h3>",
  '- text: "5. Usable as a building block, not just a CLI"',
  `- HTML: ${tick}<h3>5. Usable as a building block, not just a CLI</h3>${tick}`,
  "- current styles: color: rgb(31, 31, 29); fontSize: 15px",
].join(newline);

const parsed = parseHtmlReferenceText(serialized);
assert.equal(parsed.text, "修改文案为 Usable Test");
assert.equal(parsed.references.length, 1);
assert.equal(parsed.references[0].tagName, "h3");
assert.equal(parsed.references[0].selector, "body > h3");
assert.equal(parsed.references[0].text, "5. Usable as a building block, not just a CLI");
assert.equal(parsed.references[0].styles?.fontSize, "15px");

const chinese = parseHtmlReferenceText(serialized.replace("[Selected HTML element]", "[已选中的 HTML 元素]"));
assert.equal(chinese.references.length, 1);
assert.equal(chinese.text, "修改文案为 Usable Test");

const untouched = "用户手写的 [Selected HTML element] 文本，不应被误判。";
assert.deepEqual(parseHtmlReferenceText(untouched), { text: untouched, references: [] });

console.log("html reference tests passed");
