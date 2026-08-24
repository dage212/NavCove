/**
 * 切片上传服务（断点续传，用于大文件 CSV 导入）
 *
 * 存储结构：
 *   server/data/uploads/
 *     {uploadId}.json          -> 上传元信息（文件名、总大小、总切片数、已完成切片列表等）
 *     {uploadId}/              -> 切片目录
 *       chunk_0, chunk_1, ...  -> 按 index 命名的切片文件
 *
 * 流程：
 *   POST /api/import/upload/init        -> 返回 { uploadId, needChunks: [0,2,..] }（已存在则返回剩余缺失切片）
 *   POST /api/import/upload/chunk       -> 传切片（uploadId + index + blob），200 OK 表示落盘成功
 *   POST /api/import/upload/merge       -> 按序号合并切片成目标 CSV，调用 mysqlService.importCsvFileStream 导入，然后清理
 *   DELETE /api/import/upload/:uploadId -> 手动取消并清理
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { dataDir } = require('../paths');
const UPLOAD_DIR = path.join(dataDir, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 临时文件日志（调试 merge 崩溃问题）
const logFile = path.join(UPLOAD_DIR, 'debug.log');
function debugLog(msg) {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n'); } catch (e) {}
}

function metaPath(uploadId) {
  return path.join(UPLOAD_DIR, uploadId + '.json');
}
function chunkDir(uploadId) {
  return path.join(UPLOAD_DIR, uploadId);
}
function chunkFile(uploadId, index) {
  return path.join(chunkDir(uploadId), `chunk_${index}`);
}

function readMeta(uploadId) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(uploadId), 'utf8'));
  } catch (e) {
    return null;
  }
}
function writeMeta(meta) {
  fs.writeFileSync(metaPath(meta.uploadId), JSON.stringify(meta, null, 2));
}
function missingChunks(meta) {
  const set = new Set(meta.done || []);
  const arr = [];
  for (let i = 0; i < meta.totalChunks; i++) if (!set.has(i)) arr.push(i);
  return arr;
}

/**
 * 初始化上传任务（断点续传核心：同一 fileKey 返回同一个 uploadId，并告知缺少的切片）
 * @param {object} args
 * @param {string} args.fileName  原文件名
 * @param {number} args.fileSize  文件总字节数
 * @param {number} args.chunkSize 切片大小（字节），只用来推断 totalChunks
 * @param {string} args.fileHash  客户端算的文件 md5/xxhash（用于断点续传命中同任务），可为空
 * @returns {{ uploadId:string, totalChunks:number, doneChunks:number[], needChunks:number[], merged:boolean, imported:boolean }}
 */
function initUpload({ fileName, fileSize, chunkSize, fileHash }) {
  if (!fileName || fileSize == null || !chunkSize) {
    const err = new Error('缺少必要参数：fileName/fileSize/chunkSize');
    err.status = 400; throw err;
  }
  const totalChunks = Math.max(1, Math.ceil(fileSize / chunkSize));
  // key：优先 fileHash；没有则用 名字+大小 的 md5
  const key = fileHash || crypto.createHash('md5').update(`${fileName}|${fileSize}|${chunkSize}`).digest('hex');
  const uploadId = key; // uploadId 直接等于 key，保证断点续传命中
  let meta = readMeta(uploadId);
  if (!meta) {
    meta = {
      uploadId,
      fileName,
      fileSize,
      chunkSize,
      totalChunks,
      done: [],        // 已完成的切片 index 数组
      merged: false,   // 是否已合并
      mergedFilePath: null,
      imported: false, // 是否已成功导入
      createdAt: Date.now()
    };
    fs.mkdirSync(chunkDir(uploadId), { recursive: true });
    writeMeta(meta);
  }
  return {
    uploadId,
    totalChunks: meta.totalChunks,
    doneChunks: meta.done.slice(),
    needChunks: missingChunks(meta),
    merged: meta.merged,
    imported: meta.imported
  };
}

/**
 * 保存一个切片（若已存在直接跳过，保证幂等）
 * @returns {{saved:boolean, doneCount:number, totalChunks:number}}
 */
function saveChunk({ uploadId, index, buffer }) {
  const meta = readMeta(uploadId);
  if (!meta) { const e = new Error('uploadId 不存在'); e.status = 404; throw e; }
  if (meta.merged || meta.imported) {
    const e = new Error('该上传已完成合并/导入，请勿继续上传'); e.status = 400; throw e;
  }
  if (index < 0 || index >= meta.totalChunks) {
    const e = new Error('index 越界'); e.status = 400; throw e;
  }
  fs.mkdirSync(chunkDir(uploadId), { recursive: true });
  fs.writeFileSync(chunkFile(uploadId, index), buffer);
  const set = new Set(meta.done);
  set.add(index);
  meta.done = Array.from(set).sort((a, b) => a - b);
  writeMeta(meta);
  return { saved: true, doneCount: meta.done.length, totalChunks: meta.totalChunks };
}

/**
 * 合并切片并（可选）导入数据库
 * @param {object} opt
 * @param {string} opt.uploadId
 * @param {(mergedFilePath:string)=>Promise<any>} [opt.importFn] 可选：合并后执行的导入函数
 * @returns {Promise<{mergedFilePath,size,imported?:any}>}
 */
async function mergeUpload({ uploadId, importFn }) {
  debugLog('[mergeUpload] start, uploadId: ' + uploadId);
  const meta = readMeta(uploadId);
  if (!meta) { const e = new Error('uploadId 不存在'); e.status = 404; throw e; }
  const miss = missingChunks(meta);
  if (miss.length) {
    const e = new Error(`还有 ${miss.length} 个切片未上传`);
    e.status = 400;
    e.data = { missingChunks: miss };
    throw e;
  }
  if (!meta.mergedFilePath) {
    debugLog('[mergeUpload] merging chunks, totalChunks: ' + meta.totalChunks);
    const mergedDir = UPLOAD_DIR;
    const mergedFile = path.join(mergedDir, `${uploadId}_${meta.fileName}`);
    // 同步合并切片（避免 createWriteStream 文件句柄未释放导致后续读取卡住）
    const chunks = [];
    for (let i = 0; i < meta.totalChunks; i++) {
      const cPath = chunkFile(uploadId, i);
      const buf = fs.readFileSync(cPath);
      chunks.push(buf);
      debugLog('[mergeUpload] chunk ' + i + ' size: ' + buf.length);
    }
    fs.writeFileSync(mergedFile, Buffer.concat(chunks));
    meta.mergedFilePath = mergedFile;
    meta.merged = true;
    writeMeta(meta);
    debugLog('[mergeUpload] merge done, file: ' + mergedFile + ', size: ' + fs.statSync(mergedFile).size);
  }
  const stat = fs.statSync(meta.mergedFilePath);
  const result = { mergedFilePath: meta.mergedFilePath, size: stat.size };
  if (typeof importFn === 'function') {
    debugLog('[mergeUpload] calling importFn, file: ' + meta.mergedFilePath);
    try {
      result.imported = await importFn(meta.mergedFilePath);
      debugLog('[mergeUpload] importFn done, inserted: ' + (result.imported && result.imported.inserted));
      meta.imported = true;
      writeMeta(meta);
    } catch (e) {
      debugLog('[mergeUpload] importFn FAILED: ' + e.message + ' | code: ' + e.code + ' | sqlMessage: ' + e.sqlMessage);
      throw e;
    } finally {
      // 不管导入成功与否，最后都清理缓存文件（切片、meta、合并文件）
      cleanup(uploadId);
      debugLog('[mergeUpload] cleanup done');
    }
  } else {
    try { fs.rmSync(chunkDir(uploadId), { recursive: true, force: true }); } catch (e) {}
  }
  debugLog('[mergeUpload] return result');
  return result;
}

/**
 * 清理上传目录（取消或导入完成后）
 * @param {string} uploadId
 */
function cleanup(uploadId) {
  const meta = readMeta(uploadId);
  try { fs.rmSync(chunkDir(uploadId), { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(metaPath(uploadId), { force: true }); } catch (e) {}
  if (meta && meta.mergedFilePath) {
    try { fs.rmSync(meta.mergedFilePath, { force: true }); } catch (e) {}
  }
}

module.exports = {
  UPLOAD_DIR,
  initUpload,
  saveChunk,
  mergeUpload,
  cleanup,
  readMeta,
  missingChunks
};
