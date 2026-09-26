/**
 * 配置层单元测试（util/config.mjs）：权限三档 / 计划模式字段 + 实验特性解析器。
 * 数据隔离：用临时目录作 AURORAAGENT_DATA_DIR，测完还原，绝不写真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, experimentalEnabled, PERMISSION_MODES, DEFAULT_PERMISSION_MODE } from '../util/config.mjs';

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
