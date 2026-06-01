// 注意：本模块以 String.fromCharCode 构造 HTML 实体，而非直接写 '&amp;' 之类字面量。
//
// 原因：本前端界面发布时，dist/index.html 会被整段塞进酒馆「正则替换」的“替换为”里，
// 该链路会对内容做一次 HTML 实体解码。若源码里出现 '&#39;' 字面量，发布后会被解码成
// '''（裸单引号），导致 `.replace(/'/g,''')` 这类语句变成 JS 语法错误，整个内联
// <script type="module"> 解析失败，界面全白。
//
// 用 String.fromCharCode(38,...) 在运行时拼出实体，产物里只剩纯数字，过任意次 HTML
// 解码都不受影响；terser 默认 unsafe:false，也不会把它折叠回 '&amp;'。
const AMP = String.fromCharCode(38); // &
const SEMI = String.fromCharCode(59); // ;
const HASH = String.fromCharCode(35); // #

/** 构造形如 `&name;` 的具名实体（如 amp / lt / gt / quot）。 */
function namedEntity(name: string): string {
  return AMP + name + SEMI;
}

/** 构造形如 `&#code;` 的数字实体（如 39 → 单引号）。 */
function numericEntity(code: number): string {
  return AMP + HASH + String(code) + SEMI;
}

/**
 * 将文本转义为可安全嵌入 HTML 的字符串。
 * 转义结果用运行时构造的实体，避免源码中出现会被发布链路解码的 `&xxx;` 字面量。
 */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, namedEntity('amp'))
    .replace(/</g, namedEntity('lt'))
    .replace(/>/g, namedEntity('gt'))
    .replace(/"/g, namedEntity('quot'))
    .replace(/'/g, numericEntity(39));
}
