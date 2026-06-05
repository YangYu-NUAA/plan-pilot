// 规则语义回归测试。零依赖，运行：npm test （即 node --test test/）。
// 覆盖此前的两个回归：①长会议被闸门吞掉；②购票任务被错误钉到车次/出发时间。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeSingleActionItem,
  isTicketPurchaseTask,
  pinnableTimeForTitle,
  isMeetingSentence,
  isBusySentence,
  isPostMeetingTask,
  normalizeSentence,
} from "../src/planningSemantics.js";

test("闸门：超过 24 字但单一的会议描述应放行（修复长会议被吞）", () => {
  const meeting = "下午3点在四号楼第二会议室召开本周课题组例会讨论进展"; // >24 字，单事件
  assert.ok(meeting.length > 24, "测试用例本身应超过旧的 24 字上限");
  assert.equal(looksLikeSingleActionItem(meeting), true);
});

test("闸门：串联多件事的口语应交给 LLM（不被规则切成一条）", () => {
  assert.equal(looksLikeSingleActionItem("晚上6点出门过生日一件事然后下午2点去医院挂号"), false);
});

test("闸门：情绪/元描述句应跳过", () => {
  assert.equal(looksLikeSingleActionItem("其他固定安排暂时没有但有点焦虑"), false);
});

test("闸门：干净的单条仍放行", () => {
  assert.equal(looksLikeSingleActionItem("下午2点去医院挂号"), true);
  assert.equal(looksLikeSingleActionItem("写周报"), true);
});

test("闸门：极长粘贴段落兜底跳过", () => {
  assert.equal(looksLikeSingleActionItem("把第一章引言改完再把第二章方法补全顺便整理参考文献并导出PDF发给导师审阅一遍"), false);
});

test("购票识别", () => {
  assert.equal(isTicketPurchaseTask("购买晚上8:41回淮南的火车票"), true);
  assert.equal(isTicketPurchaseTask("整理组会纪要"), false);
});

test("购票时间守卫：购票任务不按标题里的车次时间钉定（修复 20:41 误钉）", () => {
  assert.equal(pinnableTimeForTitle("购买晚上8:41回淮南的火车票", "20:41"), "");
});

test("非购票任务的明确时间仍可钉定", () => {
  assert.equal(pinnableTimeForTitle("下午3点交报告给导师", "15:00"), "15:00");
  assert.equal(pinnableTimeForTitle("写代码", ""), "");
});

test("会议/不可用句判定", () => {
  assert.equal(isMeetingSentence("开课题组会议"), true);
  assert.equal(isMeetingSentence("购买火车票"), false);
  assert.equal(isBusySentence("下午去医院"), true);
  assert.equal(isBusySentence("购买火车票"), false);
});

test("会后整理任务判定", () => {
  assert.equal(isPostMeetingTask("整理组会纪要"), true);
  assert.equal(isPostMeetingTask("写报告"), false);
});

test("句子规整去除首尾标点", () => {
  assert.equal(normalizeSentence("，下午开会。"), "下午开会");
});
