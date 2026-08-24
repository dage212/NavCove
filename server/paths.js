const path = require('path');
const fs = require('fs');

// 打包后 asar 只读，数据目录由 Electron 通过 NAVCOVE_DATA_DIR 传入可写路径
const dataDir = process.env.NAVCOVE_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

module.exports = { dataDir };
