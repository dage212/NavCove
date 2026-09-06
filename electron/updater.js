const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

const REMOTE_PKG_URL = 'https://raw.githubusercontent.com/dage212/NavCove/master/package.json';
const GH_API_RELEASES = 'https://api.github.com/repos/dage212/NavCove/releases';
const USER_AGENT = 'NavCove-Updater';

let lastCheck = null;

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function request(url, { json = false, dest = null, onProgress = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const doReq = (target, hops = 0) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const lib = target.startsWith('https:') ? https : http;
      const req = lib.get(target, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: json ? 'application/vnd.github+json, application/json' : '*/*'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doReq(new URL(res.headers.location, target).toString(), hops + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        if (dest) {
          const total = Number(res.headers['content-length'] || 0);
          let received = 0;
          const file = fs.createWriteStream(dest);
          res.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress && total) onProgress(Math.round((received / total) * 100));
          });
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve(dest)));
          file.on('error', reject);
          res.on('error', reject);
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (!json) return resolve(data);
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    };
    doReq(url);
  });
}

async function fetchLatestVersion() {
  const pkg = await request(REMOTE_PKG_URL, { json: true, timeout: 10000 });
  const version = pkg && pkg.version;
  if (!version) throw new Error('no version');
  return String(version);
}

async function check(currentVersion) {
  const current = String(currentVersion || '0.0.0');
  const latest = await fetchLatestVersion();
  lastCheck = {
    current,
    latest,
    available: compareVersion(current, latest) < 0
  };
  return lastCheck;
}

function versionMatches(release, version) {
  const tag = String(release.tag_name || '').replace(/^v/i, '');
  const name = String(release.name || '').replace(/^v/i, '');
  const v = String(version).replace(/^v/i, '');
  return tag === v || name === v || name.includes(v);
}

function pickAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const platform = process.platform;
  const arch = process.arch;
  const usable = (a) => a && a.name && !/\.blockmap$/i.test(a.name);
  if (platform === 'win32') {
    return list.find((a) => usable(a) && /\.exe$/i.test(a.name));
  }
  if (platform === 'darwin') {
    const dmg = list.filter((a) => usable(a) && /\.dmg$/i.test(a.name));
    const archName = arch === 'arm64' ? 'arm64' : 'x64';
    return dmg.find((a) => a.name.toLowerCase().includes(archName)) || dmg[0];
  }
  return list.find((a) => usable(a) && /\.AppImage$/i.test(a.name))
    || list.find((a) => usable(a) && /\.deb$/i.test(a.name));
}

function guessDownloadUrls(version) {
  const v = String(version).replace(/^v/i, '');
  const base = `https://github.com/dage212/NavCove/releases/download/v${v}`;
  if (process.platform === 'win32') {
    return [
      `${base}/NavCove Setup ${v}.exe`,
      `${base}/NavCove-Setup-${v}.exe`,
      `${base}/NavCove-${v}.exe`
    ];
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return [
      `${base}/NavCove-${v}-${arch}.dmg`,
      `${base}/NavCove-${v}.dmg`
    ];
  }
  return [
    `${base}/NavCove-${v}.AppImage`,
    `${base}/NavCove-${v}.deb`
  ];
}

async function findDownload(version) {
  try {
    const releases = await request(GH_API_RELEASES, { json: true, timeout: 10000 });
    const list = Array.isArray(releases) ? releases : [];
    const rel = list.find((r) => versionMatches(r, version)) || list.find((r) => !r.draft);
    const asset = rel && pickAsset(rel.assets);
    if (asset && asset.browser_download_url) {
      return { url: asset.browser_download_url, name: asset.name };
    }
  } catch (e) {}
  const urls = guessDownloadUrls(version);
  return { url: urls[0], name: path.basename(decodeURIComponent(urls[0])), fallbacks: urls.slice(1) };
}

function launchInstaller(filePath) {
  if (process.platform === 'win32') {
    const child = spawn(filePath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { quit: true };
  }
  shell.openPath(filePath);
  return { launched: true };
}

async function downloadWithFallback(info, dest, onProgress) {
  const urls = [info.url, ...(info.fallbacks || [])];
  let lastErr = null;
  for (const url of urls) {
    try {
      await request(url, { dest, onProgress, timeout: 30000 });
      return dest;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dest); } catch (err) {}
    }
  }
  throw lastErr || new Error('download failed');
}

async function install({ onProgress } = {}) {
  if (!lastCheck) await check(app.getVersion());
  if (!lastCheck?.available) return { available: false };

  const info = await findDownload(lastCheck.latest);
  const dest = path.join(os.tmpdir(), info.name || `NavCove-update-${lastCheck.latest}`);
  await downloadWithFallback(info, dest, onProgress);
  return launchInstaller(dest);
}

module.exports = { check, install, compareVersion };
