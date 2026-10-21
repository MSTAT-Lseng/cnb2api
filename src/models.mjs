// 上游模型名嗅探注册表。
//
// 背景：CNB 的 AI 网关没有「列模型」接口（/-/ai/models 等一律 404），
// 但每个 chat/completions 响应都会回显它真正路由到的模型名（如
// deepseek-v4.1-flash）。因此唯一的真实来源是「读响应里的 model 字段」。
//
// 策略（纯被动，零额外请求，不主动测活）：
//   - 每次转发成功的响应里观察到的 model 名登记进内存注册表（首见顺序去重）；
//   - 新模型出现时落盘持久化，重启后先加载，避免冷启动丢历史；
//   - GET /v1/models 优先返回嗅探到的真实名；尚未嗅探到任何名字时回退
//     config.models（即 PROXY_MODELS，人工固化自 /v1/models 的历史返回值）。
import fs from 'node:fs';
import { config } from './config.mjs';
import { log } from './log.mjs';

/** @type {string[]} 首见顺序的去重上游模型名 */
let observed = [];
const seen = new Set();
let loaded = false;

function load() {
  loaded = true;
  try {
    const raw = fs.readFileSync(config.modelsStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.models) ? parsed.models : [];
    for (const m of list) {
      if (typeof m === 'string' && m && !seen.has(m)) { seen.add(m); observed.push(m); }
    }
    if (observed.length) log.info('-', 'models: loaded state', { count: observed.length, path: config.modelsStatePath });
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('-', 'models: state load failed', { err: String(e).slice(0, 160), path: config.modelsStatePath });
  }
}

function persist() {
  try {
    const tmp = `${config.modelsStatePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ models: observed, updated_at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, config.modelsStatePath); // 原子替换，避免半写文件
  } catch (e) {
    // 持久化失败不致命：内存注册表仍可用，只是重启后可能冷启动
    log.warn('-', 'models: state persist failed', { err: String(e).slice(0, 160), path: config.modelsStatePath });
  }
}

// 观察一个上游回显的模型名。首次见到才登记 + 落盘（后续命中直接返回）。
export function observe(model) {
  if (typeof model !== 'string') return;
  const m = model.trim();
  if (!m || m === 'unknown') return;
  if (!loaded) load();
  if (seen.has(m)) return;
  seen.add(m);
  observed.push(m);
  log.info('-', 'models: discovered upstream model', { model: m });
  persist();
}

// /v1/models 的模型列表：优先真实嗅探名，尚无样本时回退 PROXY_MODELS。
export function list() {
  if (!loaded) load();
  return observed.length ? [...observed] : [...config.models];
}

// 快照：供调试/测试观察注册表来源。
export function snapshot() {
  if (!loaded) load();
  return { source: observed.length ? 'upstream' : 'configured', observed: [...observed], fallback: [...config.models] };
}
