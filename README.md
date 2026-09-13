**English** | **[中文](./README.zh-CN.md)**

# NavCove — Cross-platform Database Management Tool

A Navicat-like desktop database manager, packaged with Electron. It supports **MySQL** and **Redis** in the same window: multi-connection tabs, SQL / Redis command editing, visual table CRUD (including tables without a primary key), foreign-key relation diagrams, CSV/SQL import and export, and an operation-log audit trail. The UI is available in **English** and **Simplified Chinese**.

Default login: `admin` / `123456`.

## Screenshots

### Sign in

Switch language on the login page, then sign in.

![Sign in](./navcode_login.png)

### Workspace

Connection tabs, schema tree, SQL editor, and an editable result grid. Open several tables at once; the tab label is `database.table`.

![Workspace](./navcat_inner.png)

### Table relations

Right-click a table → **View table relations**. The diagram lays out foreign keys field-to-field; drag empty space to pan, drag a card to move a table.

![Table relations](./navcat_relation.png)

### Activity log

Every SQL / Redis command is recorded. Filter by date, user, and statement type.

![Activity log](./navcat_log.png)

## Tech Stack

- **Desktop**: Electron + electron-builder (native macOS traffic lights / custom window controls on Windows)
- **Frontend**: Vue 3 + Element Plus + Vite + CodeMirror 5 (SQL highlighting / autocomplete / comment toggle)
- **Backend**: Node.js + Koa + mysql2 + ioredis + better-sqlite3
- **Databases**: MySQL / Redis (business data) + SQLite (users / connections / operation-log metadata)

## Project Structure

```
NavCove/
├── electron/                    # Electron main process
│   └── main.js                  # Window creation, platform-aware title bar
├── server/                      # Koa backend
│   ├── app.js                   # Entry (CORS / static / SPA fallback / error handling)
│   ├── config.js                # Default connection config
│   ├── db/sqlite.js             # SQLite: users / connections / operation_log
│   ├── db/pool.js               # MySQL / Redis pool manager (cached by connection ID)
│   ├── services/mysqlService.js # MySQL operations (query / CRUD / DDL / relations / CSV·SQL I/O)
│   ├── services/redisService.js  # Redis keys / commands
│   ├── services/uploadService.js# Chunked CSV upload / resume / merge
│   └── routes/index.js          # API routes + operation logging
├── web/                         # Vue frontend
│   ├── src/
│   │   ├── App.vue              # Main layout (title bar / connection tabs / sidebar / editor + results / resizers)
│   │   ├── api/index.js         # axios wrapper
│   │   ├── components/
│   │   │   ├── TitleBar.vue          # Title bar (window controls / user menu)
│   │   │   ├── ConnectionDialog.vue  # Connection manager dialog
│   │   │   ├── ImportDialog.vue      # CSV import dialog (chunked upload)
│   │   │   ├── ExportSqlDialog.vue   # SQL export dialog
│   │   │   ├── ResultTable.vue       # Result grid (edit / add-delete rows / export)
│   │   │   ├── StructureView.vue     # Table structure view
│   │   │   ├── RelationView.vue       # Table relation diagram (foreign keys)
│   │   │   └── OperationLog.vue      # Operation log tab
│   │   └── styles/main.css     # Global styles (iOS blue theme)
│   └── vite.config.js          # Dev proxy /api -> :3000
└── package.json                # Electron packaging config
```

## Quick Start

### 1. Install dependencies

Requires **Node.js 23.7.0** (see `.nvmrc` / `package.json` `engines`). The repo is an **npm workspace**; one install at the root covers `web`, `server`, and Electron:

```bash
# From the repo root
nvm use          # switches to 23.7.0
npm install      # installs web + server + root Electron deps
```

> Package manager: npm. `engine-strict=true` in [.npmrc](./.npmrc) rejects any other Node version.

### 2. Development (backend + frontend + Electron)

```bash
# From the repo root
npm run dev      # backend :3000 + frontend :5173 + Electron window
```

Other commands:

```bash
npm run dev:web       # frontend only
npm run dev:server    # backend only
```

### 3. Packaging

```bash
npm run dist:win     # Windows NSIS + portable
npm run dist:mac     # macOS dmg + zip
npm run dist:linux   # Linux AppImage + deb
```

Artifacts are written to `release/`.

## Features

| Module | Description |
|------|------|
| Auth | Login / logout (SQLite `users` table + session token) |
| Connections | Multi-connection tabs (per-tab SQL / results / tree state), MySQL and Redis side by side, test connection, create / close |
| Schema tree | Lazy-load databases → tables (or Redis DBs → keys); table nodes show exact row counts (`COUNT(*)`) |
| SQL editor | CodeMirror 5 highlighting / autocomplete / bracket matching, Ctrl+/ comments, Ctrl+Enter run, database switcher, resizable height |
| SQL execution | Split statements on `;`, SELECT returns result sets, writes return affected rows, error location |
| Result grid | Pagination (20/50/100/200), column sort, sticky header + inner scroll, sticky new rows, multiple result tabs |
| Table editing | Inline edit, insert row, delete row, batch save (transaction); SELECT results are editable; tables without a primary key match the whole row |
| Table relations | Foreign-key ER diagram: pan the canvas, drag tables, lines attach to fields; incoming / outgoing FK tables below |
| CSV import | Chunked upload + resume + merge; INSERT append / REPLACE overwrite; auto-convert nonstandard dates |
| CSV export | Export table data or query results (streaming, UTF-8 BOM, Excel-friendly) |
| SQL export | Full table `CREATE TABLE` + `INSERT`, or export query results as `INSERT` |
| SQL import | Run imported `.sql` files (escapes, multiple statements) |
| DDL | Create/drop/truncate/copy/rename tables; create/drop databases; change charset (with confirm) |
| Table structure | View columns / types / indexes / DDL |
| Operation log | Records every SQL action (user / time / type / full SQL / affected rows / status); filter by date / user / SQL type |
| Layout | Draggable sidebar width, draggable editor/result height, collapsible sidebar; English / 简体中文 |
| Platforms | Native macOS traffic lights, custom window controls on Windows/Linux, iOS blue theme |

## Default Connection

`server/config.js` defines the default connection (local MySQL `root` with no password). Edit that file, or fill in the “New Connection” dialog in the UI.

## Metadata Storage

The SQLite database (`server/data/app.db`) stores:

- `users` — system users
- `connections` — saved database connections
- `operation_log` — SQL audit log
