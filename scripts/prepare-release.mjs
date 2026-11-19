import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'jiuxina/jian-translator';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})(?![\s\S])/i;

function releaseVersion(value) {
  const match = typeof value === 'string' && VERSION.exec(value);
  if (!match || !match.slice(1).every(part => Number.isSafeInteger(Number(part)))) {
    throw new Error('版本必须是正式三段版本号，例如 2.2.0');
  }
  return value;
}

async function regularInput(filename) {
  const resolved = await realpath(filename);
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error(`发布输入必须是普通文件：${filename}`);
  return { resolved, details };
}

function decodeUtf8(bytes, filename) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`文本不是有效 UTF-8：${filename}`);
  }
}

function inputLabel(filename, projectRoot) {
  const relative = path.relative(projectRoot, filename);
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/') : filename;
}

export function parseArguments(args) {
  const names = {
    '--version': 'version', '--windows-dir': 'windowsDir', '--macos-dir': 'macosDir',
    '--android': 'androidPath',
    '--out-dir': 'outDir', '--revision': 'revision', '--tag': 'tag'
  };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]];
    const value = args[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error(`无效、缺值或重复的参数：${args[index]}`);
    }
    options[key] = value;
  }
  return options;
}

export async function prepareRelease(options) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  if (!options.windowsDir || !options.macosDir || !options.androidPath || !options.outDir) {
    throw new Error('必须提供 --windows-dir、--macos-dir、--android 和 --out-dir');
  }
  const manifestPath = path.join(projectRoot, 'app', 'macos', 'package.json');
  const packageJson = JSON.parse(decodeUtf8(await readFile(manifestPath), manifestPath));
  const appVersion = releaseVersion(packageJson.version);
  const version = releaseVersion(options.version || appVersion);
  if (version !== appVersion) throw new Error('发布版本与应用构建清单不一致');
  if (Object.hasOwn(options, 'tag') && options.tag !== `v${version}`) {
    throw new Error('标签与发布版本不一致：必须为 v' + version);
  }
  const revision = options.revision || execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: projectRoot, encoding: 'utf8', windowsHide: true
  }).trim();
  if (!REVISION.test(revision)) throw new Error('源码提交必须是完整的 Git 提交 SHA');
  const destination = path.resolve(options.outDir);
  try {
    await lstat(destination);
    throw new Error(`输出目录已存在，不覆盖：${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const sources = [
    { source: path.join(path.resolve(options.windowsDir), '笺.exe'),
      name: `Jian-${version}-windows-x64.exe`, platform: 'windows', architecture: 'x64' },
    { source: path.join(path.resolve(options.windowsDir), '笺.msi'),
      name: `Jian-${version}-windows-x64.msi`, platform: 'windows', architecture: 'x64' },
    { source: path.join(path.resolve(options.macosDir), `笺-${version}-macOS-universal.dmg`),
      name: `Jian-${version}-macOS-universal.dmg`, platform: 'macos', architecture: 'universal' },
    { source: path.join(path.resolve(options.macosDir), `笺-${version}-macOS-universal.zip`),
      name: `Jian-${version}-macOS-universal.zip`, platform: 'macos', architecture: 'universal' },
    { source: path.resolve(options.androidPath),
      name: `Jian-${version}-android.apk`, platform: 'android', architecture: 'multi-abi' }
  ];
  const identities = new Set();
  const assets = [];
  for (const item of sources) {
    const input = await regularInput(item.source);
    const identity = process.platform === 'win32' ? input.resolved.toLowerCase() : input.resolved;
    const fileId = input.details.ino ? `${input.details.dev}:${input.details.ino}` : null;
    if (identities.has(identity) || (fileId && identities.has(fileId))) {
      throw new Error('不同发布附件不能指向同一个输入文件');
    }
    identities.add(identity);
    if (fileId) identities.add(fileId);
    const bytes = await readFile(input.resolved);
    if (!bytes.length) throw new Error(`发布附件为空：${item.source}`);
    assets.push({
      ...item, bytes,
      input: inputLabel(input.resolved, projectRoot),
      sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase()
    });
  }
  const notesPath = path.join(projectRoot, 'docs', 'releases', `v${version}.md`);
  const notesFile = await regularInput(notesPath);
  const notes = decodeUtf8(await readFile(notesFile.resolved), notesPath);
  if (!notes.trim()) throw new Error('发布说明不能为空');
  const manifest = {
    version, tag: `v${version}`, title: `笺 ${version}`,
    repository: REPOSITORY, draft: true, prerelease: true, makeLatest: false,
    sourceRevision: revision.toLowerCase(),
    assets: assets.map(({ name, bytes, sha256, input, platform, architecture }) => ({
      name, bytes: bytes.length, sha256, input, platform, architecture
    })),
    verification: {
      preparer: ['regular input files', 'distinct inputs', 'SHA-256 of copied bytes',
        'new output directory', ...(Object.hasOwn(options, 'tag') ? ['trigger tag equals manifest tag'] : [])],
      priorTaskEvidence: version === '2.2.0' ? {
        browser: { passed: 97, total: 107, fullRerunAfterFixes: false,
          log: 'output/verify-presets-final.log' },
        rust: { passed: 93, total: 93, log: 'output/verify-presets-rust-final.log' },
        targeted: 'Subsequent targeted checks are described in docs/desktop-integration.md.',
        nativeDevices: 'Windows DPI/visuals, Android rendering and macOS remain unverified.'
      } : null,
      note: 'This preparer does not run tests, inspect signing keys, publish, push or create a tag.'
    }
  };

  // Every input is validated before the first output write. mkdir is exclusive;
  // files use wx and are never overwritten or deleted if preparation fails.
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination);
  for (const asset of assets) {
    await writeFile(path.join(destination, asset.name), asset.bytes, { flag: 'wx' });
  }
  const sums = assets.map(asset => `${asset.sha256}  ${asset.name}`).join('\n') + '\n';
  await writeFile(path.join(destination, 'SHA256SUMS.txt'), sums, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(destination, 'RELEASE_NOTES.md'), notes, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(destination, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { directory: destination, manifest };
}

const entry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (entry === import.meta.url) {
  prepareRelease(parseArguments(process.argv.slice(2))).then(result => {
    console.log(`已准备 ${result.manifest.tag} 草稿附件：${result.directory}`);
    console.log('尚未创建标签、推送、上传或发布 Release。');
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
