import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, tryExtractJson, sliceBalancedJson } from "../src/jsonExtract.js";

test("纯对象直接解析", () => {
  assert.deepEqual(extractJson('{"message":"ok","tasks":[]}'), { message: "ok", tasks: [] });
});

test("数组根（弱模型常直接吐数组而非对象）", () => {
  assert.deepEqual(extractJson('[{"title":"a"},{"title":"b"}]'), [{ title: "a" }, { title: "b" }]);
});

test("剥离 JSON 前后的解释文字", () => {
  const raw = "好的，结果如下：\n{\"message\":\"hi\",\"tasks\":[{\"title\":\"赶火车\"}]} 以上，请确认。";
  assert.deepEqual(extractJson(raw), { message: "hi", tasks: [{ title: "赶火车" }] });
});

test("剥离 markdown 代码块围栏", () => {
  assert.deepEqual(extractJson("```json\n{\"message\":\"x\"}\n```"), { message: "x" });
});

test("容忍对象/数组末尾的尾逗号", () => {
  assert.deepEqual(extractJson('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
});

test("容忍全角双引号（中文模型易犯）", () => {
  assert.deepEqual(extractJson("{“message”:“你好”}"), { message: "你好" });
});

test("字符串值里含 { 和 : 不会把括号配平带偏", () => {
  // 旧的 indexOf('{')..lastIndexOf('}') 会切歪；字符串感知配平能正确闭合。
  assert.deepEqual(extractJson('{"reason":"19:00 {重要} 出发"} 后缀'), { reason: "19:00 {重要} 出发" });
});

test("彻底非 JSON 时抛错；tryExtractJson 返回 null", () => {
  assert.throws(() => extractJson("我把今天的安排想了一遍，但没给出 JSON。"));
  assert.equal(tryExtractJson("我把今天的安排想了一遍，但没给出 JSON。"), null);
});

test("sliceBalancedJson 截断未闭合时返回到末尾（交给上层尽力解析）", () => {
  const sliced = sliceBalancedJson('前言 {"a":1, "b":2');
  assert.equal(sliced, '{"a":1, "b":2');
});
