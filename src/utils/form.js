// 表单读取与小工具。
export function sum(values) {
  return values.reduce((total, item) => total + item, 0);
}

export function fieldValue(form, name, fallback = "") {
  return form?.elements?.[name]?.value ?? fallback;
}

