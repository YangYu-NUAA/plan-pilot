// 规划语义判定（纯函数、无依赖）：句子分类、固定安排抽取闸门、购票时间守卫。
// 单独成模块以便用 `node --test` 做回归测试，并逐步拆分巨型 App.jsx。

export function normalizeSentence(sentence) {
  return String(sentence || "")
    .replace(/\s+/g, " ")
    .replace(/^[，。；;、\s]+|[，。；;、\s]+$/g, "")
    .trim();
}

export function isBusySentence(sentence) {
  if (/购买|买票|订票|预订|查票|抢票/.test(sentence)) return false;
  return /会议|开会|开[^，。；;\n]{1,24}会|课题会|组会|例会|研讨会|讨论|探讨|汇报|会谈|监考|考试|上课|答辩|面试|出发|前往|返回|通勤|火车|高铁|航班|去|外出|办事|接人|送|医院|体检|银行|办理|聚餐|午饭|午休|休息|赴|参观|出差|请假/.test(sentence);
}

export function isMeetingSentence(sentence) {
  if (/购买|买票|订票|预订|查票|抢票/.test(sentence)) return false;
  return /会议|开会|开[^，。；;\n]{1,24}会|课题会|组会|例会|研讨会|讨论|探讨|汇报|会谈/.test(sentence);
}

export function isPostMeetingTask(title) {
  return /整理|总结|纪要|复盘|行动项|后续|待办|要点/.test(title) && /会|会议|课题|讨论|探讨|汇报|组会|研讨/.test(title);
}

export function isTicketPurchaseTask(title) {
  return /购买|买票|订票|预订|查票|抢票/.test(String(title || "")) && /票|火车|高铁|车次|航班/.test(String(title || ""));
}

// 规则抽取的保守闸门：只把「单一、清晰」的句子落成任务/时间块。
// 关键信号是「多事件」（连接词、≥2 个阿拉伯数字时间、情绪/元描述），而不是单纯长度——
// 一个带地点的会议可以很长但仍是一件事，必须放行；一段串联多件事的口语必须交给 LLM。
export function looksLikeSingleActionItem(sentence) {
  const s = String(sentence || "").trim();
  if (!s) return false;
  if (s.length > 40) return false; // 仅兜底极长的粘贴段落；单事件会议通常在此之内
  if (/焦虑|压力|不知道|有点|暂时没有|没有别的|其他.{0,6}没有|很多.{0,8}(事情|要做)|事情要做|担心|纠结|烦|累/.test(s)) return false; // 情绪/元描述
  if (/(然后|接着|之后|以及|并且|还要|还得|还需|一件事|另外|顺便|再把)/.test(s)) return false; // 连接词/多事件信号
  const times = s.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*\d{1,2}\s*[点:：时]/g) || [];
  if (times.length > 1) return false; // 多个时间点 → 多事件
  return true;
}

// 购票时间守卫：购票任务标题里的时间通常是车次/出发时间，不是「几点去买票」的执行时间，
// 因此不能据此把任务钉死到该时间。返回可用于钉定的时间（空串表示不钉）。
export function pinnableTimeForTitle(title, time) {
  if (!time) return "";
  if (isTicketPurchaseTask(title)) return "";
  return time;
}
