// src/models.mjs 单元测试：回退 / 去重 / 忽略无效 / 持久化跨进程重载
// 运行：node --test test/models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, readFileSync } from 'node:fs';

// config.mjs 在 import 时就 fail-fast 校验必需 env，故先注入再动态 import。
const STATE = join(tmpdir(), `cnb2api-models-unit-${process.pid}.json`);
process.env.PROXY_KEY = 'test-key';
process.env.CNB_TOKEN = 'test-token';
process.env.CNB_REPO_SLUG = 'test/repo';
process.env.PROXY_MODELS = 'fallback-a,fallback-b';
process.env.PROXY_MODELS_STATE = STATE;

const models = await import('../src/models.mjs');

test.before(() => rmSync(STATE, { force: true }));
test.after(() => rmSync(STATE, { force: true }));

test('尚无嗅探样本时 list() 回退 PROXY_MODELS', () => {
  assert.deepEqual(models.list(), ['fallback-a', 'fallback-b']);
  assert.equal(models.snapshot().source, 'configured');
});

test('observe() 登记真实名并切换为 upstream 来源', () => {
  models.observe('deepseek-v4.1-flash');
  assert.deepEqual(models.list(), ['deepseek-v4.1-flash']);
  assert.equal(models.snapshot().source, 'upstream');
});

test('observe() 去重：同名只登记一次，保持首见顺序', () => {
  models.observe('deepseek-v4.1-flash');
  models.observe('glm-5.3-flash');
  assert.deepEqual(models.list(), ['deepseek-v4.1-flash', 'glm-5.3-flash']);
});

test('observe() 忽略空串 / 非字符串 / "unknown" 占位', () => {
  models.observe('');
  models.observe('   ');
  models.observe(undefined);
  models.observe(null);
  models.observe(42);
  models.observe('unknown');
  assert.deepEqual(models.list(), ['deepseek-v4.1-flash', 'glm-5.3-flash']);
});

test('observe() 落盘持久化', () => {
  assert.ok(existsSync(STATE), 'state file should be written after discovery');
  const parsed = JSON.parse(readFileSync(STATE, 'utf8'));
  assert.deepEqual(parsed.models, ['deepseek-v4.1-flash', 'glm-5.3-flash']);
  assert.ok(typeof parsed.updated_at === 'string');
});

test('重启后从状态文件加载（跨进程）', () => {
  // 全新进程重新 import：等价于 workspace 热重启后 boot。
  // 注意 models.mjs 加载状态时会 log.info 到 stdout，故用 RESULT 前缀标记解析。
  const script = `import(${JSON.stringify(new URL('../src/models.mjs', import.meta.url).href)}).then((m)=>process.stdout.write('RESULT' + JSON.stringify(m.list()) + '\\n'))`;
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT'));
  assert.ok(line, `no RESULT line in child stdout: ${r.stdout}`);
  assert.deepEqual(JSON.parse(line.slice('RESULT'.length)), ['deepseek-v4.1-flash', 'glm-5.3-flash']);
});
