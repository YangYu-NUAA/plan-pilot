import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, tryExtractJson, sliceBalancedJson, richestJson, isMeaningfulJson, extractJsonObjects } from "../src/jsonExtract.js";

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

test("isMeaningfulJson：含答案键才算有意义，零碎片段/空对象不算", () => {
  assert.equal(isMeaningfulJson({ message: "x" }), true);
  assert.equal(isMeaningfulJson({ actions: [] }), true);
  assert.equal(isMeaningfulJson({}), false);
  assert.equal(isMeaningfulJson({ type: "add_goal", tempId: "g1" }), false);
  assert.equal(isMeaningfulJson([1, 2]), false);
});

test("richestJson：从推理链（夹杂片段 + 最终 JSON）里捞出真正的最终答案", () => {
  // 模拟 step-3.7-flash 把答案写进 reasoning、正文只给 {} 的情形
  const reasoning = [
    "用户给了某方向的两个课题，我需要 add_goal。",
    '片段：{"type":"add_goal","tempId":"g1","goalType":"long","title":"课题甲"}',
    '再一个：{"type":"add_goal","tempId":"g2","goalType":"long","title":"课题乙"}',
    "最终JSON：",
    '{ "message": "已记录两个长期目标，接下来看下一个方向。", "done": false, "actions": [',
    '  {"type":"add_goal","tempId":"g1","goalType":"long","title":"课题甲","priority":"medium"},',
    '  {"type":"add_goal","tempId":"g2","goalType":"long","title":"课题乙","priority":"medium"}',
    "] }",
  ].join("\n");
  const best = richestJson(reasoning);
  assert.ok(best && Array.isArray(best.actions), "应捞出含 actions 的最终对象");
  assert.equal(best.actions.length, 2);
  assert.ok(best.message.includes("下一个"));
});

test("extractJsonObjects：多段顶层 JSON 全部解析、跳过非法片段", () => {
  const objs = extractJsonObjects('前言 {"a":1} 中间乱码 {oops} 又一个 {"b":2,"c":[3,4]} 末尾');
  assert.equal(objs.length, 2);
  assert.deepEqual(objs[1], { b: 2, c: [3, 4] });
});

test("sliceBalancedJson 截断未闭合时返回到末尾（交给上层尽力解析）", () => {
  const sliced = sliceBalancedJson('前言 {"a":1, "b":2');
  assert.equal(sliced, '{"a":1, "b":2');
});
