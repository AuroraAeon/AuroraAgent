#!/usr/bin/env node
/**
 * 把 LongCat 打包为独立 macOS Application（默认 ~/Applications/ModelTester.app）。
 *   node tools/build-app.mjs                   构建
 *   node tools/build-app.mjs --dest /some/dir  自定义落地目录
 *
 * 产物结构：
 *   ModelTester.app/Contents/
 *     MacOS/ModelTester       启动器（已在运行就直接开浏览器，否则后台拉起服务）
 *     Resources/app/         全部代码（web.mjs / public / util / test / tools ...）
 *     Resources/docs/        学术图与图表生成脚本
 *     AppIcon.icns           美团厂商图标（由 public/icon.svg 栅格化生成）
 *     Info.plist
 *   ~/Library/Application Support/ModelTester/   modeltester.config.json + usage.jsonl（数据与 Bundle 解耦）
 *
 * 构建后重新注册服务（指向 Bundle 内路径）：
 *   MODELTESTER_DATA_DIR="$HOME/Library/Application Support/ModelTester" \
 *     node "$PWD/ModelTester.app/Contents/Resources/app/tools/install-service.mjs"
 */
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const destIdx = process.argv.indexOf('--dest');
const DEST = destIdx > 0 ? process.argv[destIdx + 1] : join(homedir(), 'Applications');
const APP = join(DEST, 'ModelTester.app');
const CONTENTS = join(APP, 'Contents');
const BUNDLE_APP = join(CONTENTS, 'Resources', 'app');

// 自保护：源码目录位于目标 Bundle 内部时拒绝构建——rmSync 会删掉正在运行的 Bundle
if (ROOT === BUNDLE_APP || ROOT.startsWith(BUNDLE_APP + sep)) {
  console.error('拒绝构建：当前源码目录位于目标 Bundle 内部（' + ROOT + '）。');
  console.error('构建会先删除整个 .app；请先把 Resources/app 完整拷贝到 Bundle 之外的目录，再在那里执行。');
  process.exit(1);
}
const DATA_DIR = join(homedir(), 'Library', 'Application Support', 'ModelTester');
const LOG = join(homedir(), 'Library', 'Logs', 'com.modeltester.app.log');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const ICON_SVG = join(ROOT, 'public', 'icon.svg');
const TMP = join(tmpdir(), 'modeltester-build');

const sh = (cmd) => execSync(cmd, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' });
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout;
};

// 1) 清理旧 Bundle 与临时目录（数据目录不动）
if (existsSync(APP)) rmSync(APP, { recursive: true, force: true });
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
mkdirSync(BUNDLE_APP, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
console.log(`构建目标: ${APP}`);

// 2) 拷贝代码与文档
for (const f of ['web.mjs', 'chat.mjs', 'check.mjs', 'package.json', 'README.md']) {
  cpSync(join(ROOT, f), join(BUNDLE_APP, f));
}
for (const d of ['util', 'public', 'test', 'tools']) {
  cpSync(join(ROOT, d), join(BUNDLE_APP, d), { recursive: true });
}
cpSync(join(ROOT, 'docs'), join(CONTENTS, 'Resources', 'docs'), { recursive: true });
console.log('  代码与文档已拷贝');

// 3) 数据迁移（config / usage 不存在才拷贝，绝不覆盖已有数据）
for (const f of ['modeltester.config.json', 'usage.jsonl']) {
  const target = join(DATA_DIR, f);
  if (!existsSync(target) && existsSync(join(ROOT, f))) {
    cpSync(join(ROOT, f), target);
    console.log(`  数据已迁移: ${target}`);
  } else {
    console.log(`  数据已存在，跳过: ${target}`);
  }
}

// 4) 生成 AppIcon.icns（icon.svg → 多分辨率 PNG → iconset → icns）
const iconset = join(TMP, 'AppIcon.iconset');
mkdirSync(iconset, { recursive: true });
const sizes = [[16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'], [64, 'icon_32x32@2x'],
  [128, 'icon_128x128'], [256, 'icon_128x128@2x'], [256, 'icon_256x256'], [512, 'icon_256x256@2x'],
  [512, 'icon_512x512'], [1024, 'icon_512x512@2x']];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const [size, name] of sizes) {
  run(npx, ['-y', 'sharp-cli', '-i', ICON_SVG, '-o', join(iconset, `${name}.png`), 'resize', String(size), String(size)]);
}
const icns = join(CONTENTS, 'Resources', 'AppIcon.icns');
run('iconutil', ['-c', 'icns', iconset, '-o', icns]);
console.log(`  图标已生成: ${icns}`);

// 5) 启动器（Contents/MacOS/ModelTester）
const launcher = `#!/bin/zsh
# ModelTester.app 启动器：服务已在运行就直接打开浏览器；否则后台拉起服务再打开。
# 自定位目录，整个 Bundle 可随意搬移。
set -u
HERE="\${0:A:h}"
APP_DIR="$HERE/../Resources/app"
DATA_DIR="$HOME/Library/Application Support/ModelTester"
LOG="$HOME/Library/Logs/com.modeltester.app.log"
mkdir -p "$DATA_DIR"

NODE_BIN=""
for c in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -x "$c" ]] && { NODE_BIN="$c"; break; }
done
[[ -z "$NODE_BIN" ]] && NODE_BIN="$(command -v node)"

if curl -sf -m 1 http://localhost:8787/api/health >/dev/null 2>&1; then
  open http://localhost:8787
  exit 0
fi

cd "$APP_DIR"
MODELTESTER_DATA_DIR="$DATA_DIR" NO_OPEN=1 nohup "$NODE_BIN" web.mjs >>"$LOG" 2>&1 &
for i in {1..40}; do
  curl -sf -m 1 http://localhost:8787/api/health >/dev/null 2>&1 && break
  sleep 0.25
done
open http://localhost:8787
`;
const launcherPath = join(CONTENTS, 'MacOS', 'ModelTester');
mkdirSync(dirname(launcherPath), { recursive: true });
writeFileSync(launcherPath, launcher);
chmodSync(launcherPath, 0o755);
console.log(`  启动器已写入: ${launcherPath}`);

// 6) Info.plist
writeFileSync(join(CONTENTS, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>ModelTester</string>
  <key>CFBundleExecutable</key><string>ModelTester</string>
  <key>CFBundleIconFile</key><string>AppIcon.icns</string>
  <key>CFBundleIdentifier</key><string>com.modeltester.app</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>ModelTester</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

rmSync(TMP, { recursive: true, force: true });
console.log('');
console.log(`打包完成: ${APP}`);
console.log(`数据目录:   ${DATA_DIR}`);
console.log('');
console.log('下一步（注册服务，指向 Bundle）:');
console.log(`  MODELTESTER_DATA_DIR="${DATA_DIR}" node "${join(BUNDLE_APP, 'tools', 'install-service.mjs')}"`);
