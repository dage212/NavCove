# 🐬 SqlSecuriteClient — 网页版数据库管理工具

类 Navicat 的网页版数据库管理工具，支持 MySQL 连接、库/表浏览、SQL 执行、CSV 导入导出。

## 技术栈

- **前端**：Vue 3 + Element Plus + Vite + CodeMirror（SQL 高亮/补全）
- **后端**：Node.js + Koa + mysql2
- **数据库**：MySQL（架构已预留多数据库扩展点）

## 目录结构

```
SqlSecuriteClient/
├── server/                # 后端 Koa 服务
│   ├── app.js             # 入口（含静态资源托管 + SPA 回退）
│   ├── config.js          # 默认连接配置（本机 root 无密码）
│   ├── db/pool.js         # 连接池管理（按连接 ID 缓存）
│   ├── services/mysqlService.js   # MySQL 业务逻辑
│   └── routes/index.js    # API 路由
└── web/                   # 前端 Vue 应用
    ├── src/
    │   ├── App.vue        # 主布局（顶栏/左侧树/右侧编辑器+结果）
    │   ├── api/index.js   # axios 封装
    │   ├── components/
    │   │   ├── ConnectionDialog.vue  # 连接弹窗（测试/连接）
    │   │   ├── ImportDialog.vue      # CSV 导入弹窗
    │   │   └── ResultTable.vue       # 结果表格（分页/排序）
    │   └── styles/main.css
    └── vite.config.js     # dev 代理 /api -> :3000
```

## 快速开始

### 1. 启动后端

```bash
cd server
npm install
npm start          # 默认监听 http://localhost:3000
```

### 2. 启动前端（开发模式）

```bash
cd web
npm install
npm run dev        # http://localhost:5173 （自动代理 /api 到后端）
```

### 3. 生产部署（单服务）

```bash
cd web && npm run build      # 构建到 web/dist
cd ../server && npm start    # 后端自动托管 web/dist，访问 http://localhost:3000
```

## 功能说明

| 功能 | 说明 |
|------|------|
| 连接管理 | 支持测试连接、建立/断开连接；首次打开自动用默认配置连接本机 |
| 库表浏览 | 左侧树形展示数据库 → 表（懒加载），点击表查看数据 |
| SQL 编辑器 | CodeMirror 语法高亮、括号匹配、`Ctrl+Space` 补全、`Ctrl+Enter` 执行 |
| SQL 执行 | 支持多语句（分号分隔），SELECT 返回结果集、写操作返回影响行数 |
| 结果展示 | 分页（20/50/100/200）、列排序、NULL 高亮、多结果 Tab 切换 |
| 导出 CSV | 表数据导出 / 查询结果导出（带 UTF-8 BOM，Excel 兼容） |
| 导入 CSV | 上传 CSV 按首行列名映射，支持 INSERT 追加 / REPLACE 覆盖 |

## 默认连接

`server/config.js` 中配置了默认连接（本机 `root` 无密码），前端首次加载会自动连接。如需修改，编辑该文件或在前端"新建连接"弹窗中填写。
