import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const shellRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(shellRoot, '..', '..');
const generatedRoot = path.join(shellRoot, '.generated');
const resources = ['index.html', 'theme.css', 'app.js', 'langs.js', 'liquid-glass.js', 'updates.js', 'translation-stream.js'];
const args = process.argv.slice(2);
if (args.some(arg => !['--prepare-only', '--dir'].includes(arg))) {
  throw new Error('仅支持 --prepare-only 或 --dir');
}

// Windows and macOS ship the same popup script and optical engine.
const popupSource = await readFile(path.join(projectRoot, 'desktop', 'patch', 'setup.rs'), 'utf8');
const marker = 'const POPUP_BOOTSTRAP: &str = r#"';
const start = popupSource.indexOf(marker);
const end = popupSource.indexOf('"#;', start + marker.length);
if (start < 0 || end < 0) throw new Error('无法提取共享悬浮窗引导脚本');
const bootstrap = popupSource.slice(start + marker.length, end);
await mkdir(generatedRoot, { recursive: true });
await writeFile(path.join(generatedRoot, 'popup-bootstrap.js'), bootstrap, 'utf8');
const hashes = {};
for (const name of resources) {
  hashes[name] = createHash('sha256')
    .update(await readFile(path.join(projectRoot, 'web', name))).digest('hex');
}
await writeFile(path.join(generatedRoot, 'web-sha256.json'), `${JSON.stringify(hashes, null, 2)}\n`, 'utf8');
if (args.includes('--prepare-only')) {
  console.log('已准备共享悬浮窗与七项前端资源清单；未构建 macOS 安装包。');
  process.exit(0);
}
if (process.platform !== 'darwin') {
  throw new Error('macOS 打包需要在 Mac 上执行；当前只完成了共享资源准备。');
}

const cli = path.join(shellRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
await access(cli, constants.R_OK).catch(() => {
  throw new Error('缺少构建依赖，请先在 app/macos 执行 npm ci');
});
// Native macOS tools create the icon without third-party bitmap dependencies.
const iconset = path.join(generatedRoot, 'jian.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const factor of [1, 2]) {
    const pixels = size * factor;
    execFileSync('/usr/bin/sips', ['-z', String(pixels), String(pixels),
      path.join(projectRoot, 'app', 'icon.png'), '--out',
      path.join(iconset, `icon_${size}x${size}${factor === 2 ? '@2x' : ''}.png`)],
    { stdio: 'ignore' });
  }
}
const icon = path.join(generatedRoot, 'jian.icns');
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon], { stdio: 'inherit' });
const releaseName = `macos-presets-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const output = path.resolve(process.env.IT_OUT_DIR ||
  path.join(projectRoot, '.build', releaseName));
const config = {
  appId: 'ink.jian.translate',
  productName: '笺',
  asar: true,
  directories: { output },
  files: ['main.cjs', 'core.cjs', 'preload.cjs', 'popup.html', 'package.json',
    '.generated/popup-bootstrap.js', '.generated/web-sha256.json'],
  extraResources: [
    { from: path.join(projectRoot, 'web'), to: 'web', filter: resources },
    { from: path.join(projectRoot, 'app', 'icon.png'), to: 'icon.png' }
  ],
  artifactName: '笺-${version}-macOS-${arch}.${ext}',
  mac: {
    icon,
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    hardenedRuntime: true,
    extendInfo: {
      NSAppleEventsUsageDescription: '按下划词快捷键时，笺需要向当前应用发送复制选区指令。'
    }
  },
  dmg: { title: '笺 ${version}' }
};
const configPath = path.join(generatedRoot, 'electron-builder.json');
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
execFileSync(process.execPath, [cli, '--config', configPath, '--mac',
  ...(args.includes('--dir') ? ['--dir'] : []), '--universal'],
{ cwd: shellRoot, stdio: 'inherit', env: process.env });
