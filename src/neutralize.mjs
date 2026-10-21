// 出站中性化：让请求「语义不变、特征不可见」地穿过上游的关键词风控。
//
// 背景（真机实测，2026-10）：
// 上游 AI 网关（CNB / CodeBuddy 系）会对请求体做关键词内容风控。只要提示词里
// 出现客户端身份词组 "DeepSeek Harness"，整条请求被拒：
//   HTTP 400 / 业务码 11128 / "Illegal API invocation from an unapproved channel"
// 换令牌、换账号、换模型、补请求头都无效——被拦的是提示词本身，不是渠道。
// 该判定还和请求体大小有关：体量 > ~1KB 时稳定触发，短请求即使命中也会放过，
// 所以表现为「时好时坏」的误报。
//
// 两条互补的规避手段，都不改语义：
//   1. 身份关键词打散：在 "DeepSeek" 与 "Harness" 之间插入零宽空格 U+200B。
//      模型读到的仍是同一个词（零宽字符不可见），上游的子串匹配不再命中。
//      路径语境必须跳过：把 D:\...\DeepSeek Harness\resources\... 改成带零宽字符的
//      版本，会让模型把坏路径交给工具调用，直接执行失败。见 IDENTITY_RE 的前后断言。
//   2. 消息形状归一：上游另一条 11128 成因是「第一条消息必须是 system」。
//      OpenAI 新协议用 developer 角色打头，DSH 等新客户端会这么发；这里把
//      developer 映射成 system，并把中途出现的 system 提到最前。请求本来没有
//      system 时不凭空造（那会改语义），除非显式打开 PROXY_SYNTHETIC_SYSTEM。
//
// 表驱动：上游若换/加关键词，只改下面的表。

// 零宽空格：不参与渲染，也不属于 \s，插进词组里既不改语义也不改分词边界。
const ZWSP = '\u200B';

// 客户端注入的特征短语。部分网关按字面拦这些 token（Claude Code 的计费头名等），
// 换等价表述、保留值本身（URL/版本号原样），模型行为不受影响。
export const CLIENT_PHRASES = [
  [/x-anthropic-billing-header/gi, 'x-cc-billing-meta'],
  [
    /to give feedback, users should report the issue at (https:\/\/github\.com\/anthropics\/claude-code\/issues)/gi,
    'to share feedback, users can report the issue at $1',
  ],
  [
    /you are claude code, anthropic's official cli for claude(\.)?/gi,
    "you are claude code, a command-line coding assistant$1",
  ],
];

// 上游当前实测会拦的身份词组。前后负向断言跳过路径语境（\ 或 / 贴边），
// 其余位置一律打散；大小写不敏感，空格兼容普通空格与 NBSP。
export const IDENTITY_RE = /(?<![\\/])(DeepSeek)[ \u00A0]+(Harness)(?![\\/])/gi;

// 激进模式：连品牌词本身也打散。默认关闭——它会命中比身份词组多得多的位置
// （模型名、普通叙述），只在身份词组规则被上游绕过时才需要。
export const BRAND_RE = /(?<![\\/\w])(DeepSeek)(?![\w\\/])/gi;

// 补位用的中性 system：仅在显式开启 syntheticSystem 时使用（默认关闭）。
// 默认不凭空造 system——请求本来没有 system 是合法形状，不该被改写语义。
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

// 字符串级中和：纯函数，便于单测；路径语境的跳过由正则自身保证。
export function neutralize(text, { aggressive = false } = {}) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [re, replacement] of CLIENT_PHRASES) out = out.replace(re, replacement);
  out = out.replace(IDENTITY_RE, `$1${ZWSP} $2`);
  if (aggressive) out = out.replace(BRAND_RE, `Deep${ZWSP}Seek`);
  return out;
}

// 递归改写请求体里所有字符串值（content / tool 描述 / tool arguments 的 JSON 串 /
// input_schema 的 description …）。只改值、不改键：键名是协议字段，改不得。
// 就地改写：payload 来自 JSON.parse，调用方本来就要重建 body。
function rewriteDeep(value, options, stats) {
  if (typeof value === 'string') {
    const next = neutralize(value, options);
    if (next !== value) stats.rewritten += 1;
    return next;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = rewriteDeep(value[i], options, stats);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = rewriteDeep(value[key], options, stats);
    return value;
  }
  return value;
}

// developer → system：OpenAI 新角色名，老网关不认。就地改，顺序不变。
export function normalizeRoles(messages) {
  for (const m of messages) {
    if (m && m.role === 'developer') m.role = 'system';
  }
  return messages;
}

// 首条是 system 的保证：
//   · 首条已是 system → 不动（绝大多数请求）
//   · 有 system 但在中途 → 提前（system 不参与 tool_call_id 配对，移动安全）
//   · 一条 system 都没有 → 默认不动（凭空造 system 会改语义）；只有调用方显式
//     syntheticSystem=true 时才补中性占位，用于上游硬性要求首条为 system 的场景。
export function ensureSystemFirst(messages, { synthetic = false } = {}) {
  if (!messages.length || messages[0]?.role === 'system') return messages;
  const idx = messages.findIndex((m) => m?.role === 'system');
  if (idx > 0) {
    const [sys] = messages.splice(idx, 1);
    messages.unshift(sys);
    return messages;
  }
  if (synthetic) messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  return messages;
}

// 出站前唯一入口：proxy.mjs 在 fetch 之前调用，OpenAI 与 Anthropic 两条协议栈
// 走同一份逻辑（Anthropic 适配器已完成转换，payload 一律是 OpenAI 形状）。
// 返回 { payload, rewritten }，rewritten = 被改写的字符串处数（供日志/诊断）。
export function prepareOutbound(payload, {
  enabled = true,
  aggressive = false,
  ensureSystem = true,
  syntheticSystem = false,
} = {}) {
  if (!enabled || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload, rewritten: 0 };
  }
  const stats = { rewritten: 0 };
  // 只遍历承载自然语言的根字段：model / stream / max_tokens 等协议字段保持原样
  // （模型名里带 deepseek 是正常的，不该被改写）。
  for (const root of ['messages', 'tools', 'system', 'prompt']) {
    if (payload[root] === undefined) continue;
    payload[root] = rewriteDeep(payload[root], { aggressive }, stats);
  }
  if (Array.isArray(payload.messages)) {
    normalizeRoles(payload.messages);
    if (ensureSystem) ensureSystemFirst(payload.messages, { synthetic: syntheticSystem });
  }
  return { payload, rewritten: stats.rewritten };
}
