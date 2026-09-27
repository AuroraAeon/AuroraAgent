/**
 * 配置层单元测试（util/config.mjs）：权限三档 / 计划模式字段 + 实验特性解析器。
 * 数据隔离：用临时目录作 AURORAAGENT_DATA_DIR，测完还原，绝不写真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, experimentalEnabled, PERMISSION_MODES, DEFAULT_PERMISSION_MODE, TITLE_MODES, DEFAULT_TITLE_MODE } from '../util/config.mjs';
import { parseTuiConfig, TERMINAL_TITLE_ITEMS } from '../util/tui/config.mjs';
import { NOTIFICATION_EVENTS } from '../util/tui/notify.mjs';

export async function runConfigTests(test, assert, eq) {
  console.log('\n配置层单元测试');

  await test('config: loadConfig 缺省 permissionMode / planMode 等价现状', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-cfg-'));
    const prev = process.env.AURORAAGENT_DATA_DIR;
    process.env.AURORAAGENT_DATA_DIR = dir;
    try {
      const cfg = loadConfig();
      eq(cfg.permissionMode, DEFAULT_PERMISSION_MODE);
      eq(cfg.planMode, false);
      eq(PERMISSION_MODES.includes(cfg.permissionMode), true);
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_DATA_DIR; else process.env.AURORAAGENT_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('tui: parseTuiConfig 缺省值、坏值独立回退与显式关闭', () => {
    const d = parseTuiConfig(undefined);
    eq(d.terminalTitle.join(','), 'state,session,app', '缺省全项标题');
    eq(d.notifications.when, 'unfocused');
    eq(d.notifications.method, 'auto');
    eq(d.notifications.events.length, 4, '缺省四类事件都通知');
    const warns = [];
    const w = (msg, extra) => warns.push(extra?.leaf);
    // 单叶损坏独立回退：when 坏不影响 method 与 events
    const one = parseTuiConfig({ notifications: { when: '总是', method: 'bel', events: ['turn-complete', '胡扯'] } }, { warn: w });
    eq(one.notifications.when, 'unfocused', '坏 when 回退缺省');
    eq(one.notifications.method, 'bel', '好 method 不受牵连');
    eq(one.notifications.events.join(','), 'turn-complete', '坏事件项被丢弃');
    eq(warns.join(','), 'notifications.when,notifications.events', '两个坏叶各自告警');
    // 显式关闭：空数组不告警（用户主动为之）
    const off = parseTuiConfig({ terminalTitle: [], notifications: { events: [] } }, { warn: w });
    eq(off.terminalTitle.length, 0, '空项序 = 关闭标题');
    eq(off.notifications.events.length, 0, '空事件 = 关闭通知');
    eq(warns.length, 2, '显式关闭不应新增告警');
    // 非法项丢弃 + 保序去重；非数组整体回退
    const ord = parseTuiConfig({ terminalTitle: ['app', 'session', 'app', '胡扯'] });
    eq(ord.terminalTitle.join(','), 'app,session', '非法项丢弃且去重保序');
    eq(parseTuiConfig({ terminalTitle: 'state' }).terminalTitle.join(','), 'state,session,app', '非数组回退缺省');
    eq(TERMINAL_TITLE_ITEMS.join(','), 'state,session,app');
    eq(NOTIFICATION_EVENTS.length, 4);
  });

  await test('config: loadConfig 透出 tui 段且 round-trip 保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-tui-cfg-'));
    const prev = process.env.AURORAAGENT_DATA_DIR;
    process.env.AURORAAGENT_DATA_DIR = dir;
    try {
      saveConfig({ model: 'm', thinking: true, temperature: 0.5, maxTokens: 100, permissionMode: 'never_ask', planMode: true, keyIsOverride: true, tui: { terminalTitle: ['session'], notifications: { when: 'always', method: 'osc9', events: ['turn-failed'] } } });
      const cfg = loadConfig();
      eq(cfg.tui.terminalTitle.join(','), 'session', 'tui 段应透出并保留');
      eq(cfg.tui.notifications.when, 'always');
      eq(cfg.tui.notifications.method, 'osc9');
      eq(cfg.tui.notifications.events.join(','), 'turn-failed');
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_DATA_DIR; else process.env.AURORAAGENT_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('config: saveConfig → loadConfig  round-trip 保留权限与计划字段', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-cfg-'));
    const prev = process.env.AURORAAGENT_DATA_DIR;
    process.env.AURORAAGENT_DATA_DIR = dir;
    try {
      saveConfig({ model: 'm', thinking: true, temperature: 0.5, maxTokens: 100, permissionMode: 'never_ask', planMode: true, keyIsOverride: true });
      const cfg = loadConfig();
      eq(cfg.permissionMode, 'never_ask');
      eq(cfg.planMode, true);
      eq(cfg.temperature, 0.5);
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_DATA_DIR; else process.env.AURORAAGENT_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('config: 非法 permissionMode 回退缺省', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-cfg-'));
    const prev = process.env.AURORAAGENT_DATA_DIR;
    process.env.AURORAAGENT_DATA_DIR = dir;
    try {
      writeFileSync(join(dir, 'auroraagent.config.json'), JSON.stringify({ permissionMode: 'bogus' }));
      eq(loadConfig().permissionMode, DEFAULT_PERMISSION_MODE);
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_DATA_DIR; else process.env.AURORAAGENT_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('config: titleMode 缺省本地、round-trip 保留、非法值回退', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-cfg-'));
    const prev = process.env.AURORAAGENT_DATA_DIR;
    process.env.AURORAAGENT_DATA_DIR = dir;
    try {
      eq(loadConfig().titleMode, DEFAULT_TITLE_MODE, '缺省应为本地推导');
      eq(TITLE_MODES.join('|'), 'local|model');
      saveConfig({ model: 'm', thinking: true, temperature: 0.5, maxTokens: 100, permissionMode: 'never_ask', planMode: false, titleMode: 'model', keyIsOverride: true });
      eq(loadConfig().titleMode, 'model', '保存后应读回模型总结');
      writeFileSync(join(dir, 'auroraagent.config.json'), JSON.stringify({ titleMode: 'bogus' }));
      eq(loadConfig().titleMode, DEFAULT_TITLE_MODE, '非法值应回退缺省');
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_DATA_DIR; else process.env.AURORAAGENT_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('config: experimentalEnabled 单开 / 全开 / 缺省关', () => {
    const prevName = process.env.AURORAAGENT_EXPERIMENTAL_MCP;
    const prevAll = process.env.AURORAAGENT_EXPERIMENTAL_FLAG;
    try {
      delete process.env.AURORAAGENT_EXPERIMENTAL_MCP;
      delete process.env.AURORAAGENT_EXPERIMENTAL_FLAG;
      eq(experimentalEnabled('MCP'), false);
      process.env.AURORAAGENT_EXPERIMENTAL_MCP = '1';
      eq(experimentalEnabled('MCP'), true);
      eq(experimentalEnabled('OTHER'), false);
      delete process.env.AURORAAGENT_EXPERIMENTAL_MCP;
      process.env.AURORAAGENT_EXPERIMENTAL_FLAG = '1';
      eq(experimentalEnabled('MCP'), true);
      eq(experimentalEnabled('ANYTHING'), true);
    } finally {
      if (prevName === undefined) delete process.env.AURORAAGENT_EXPERIMENTAL_MCP; else process.env.AURORAAGENT_EXPERIMENTAL_MCP = prevName;
      if (prevAll === undefined) delete process.env.AURORAAGENT_EXPERIMENTAL_FLAG; else process.env.AURORAAGENT_EXPERIMENTAL_FLAG = prevAll;
    }
  });
}
