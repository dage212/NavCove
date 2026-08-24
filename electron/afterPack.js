const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function rm(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

exports.default = async function afterPack(context) {
  const appName = context.packager.appInfo.productFilename;
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const appRoot = fs.existsSync(path.join(resources, 'app'))
    ? path.join(resources, 'app')
    : resources;
  // 删除 Node 预编译包，避免覆盖 Electron 重编后的 native binding
  rm(path.join(appRoot, 'node_modules', 'better-sqlite3', 'prebuilds'));

  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execSync(`codesign --force --deep --sign - "${appPath}"`);
  try { execSync(`xattr -cr "${appPath}"`); } catch (e) {}
};
