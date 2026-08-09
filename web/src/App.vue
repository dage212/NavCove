<template>
  <!-- 登录页 -->
  <div v-if="!loggedIn" class="login-page">
    <div class="login-left">
      <div class="logo-big">🐬</div>
      <h1>SQLAdmin</h1>
      <div class="sub-title">企业级数据库管理平台</div>
      <div class="features">
        <div class="ft"><span class="ft-icon"><el-icon><Coin /></el-icon></span>支持 MySQL 多数据库连接与管理</div>
        <div class="ft"><span class="ft-icon"><el-icon><Promotion /></el-icon></span>在线 SQL 编辑器 · 语法高亮 · 智能补全</div>
        <div class="ft"><span class="ft-icon"><el-icon><Edit /></el-icon></span>表数据可视化编辑 · 暂存确认 · 批量导入导出</div>
        <div class="ft"><span class="ft-icon"><el-icon><Lock /></el-icon></span>安全鉴权 · 数据操作留痕</div>
      </div>
      <div class="copyright">© 2026 SQLAdmin · Powered by Vue 3 + Koa</div>
    </div>
    <div class="login-right">
      <div class="login-box">
        <h2 class="login-title">欢迎登录</h2>
        <p class="login-sub">请输入账号密码以登录管理平台</p>
        <el-form class="login-form" @submit.prevent="handleLogin">
          <el-form-item>
            <el-input v-model="loginForm.username" size="large" placeholder="用户名" @keyup.enter="handleLogin">
              <template #prefix><el-icon><User /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-form-item>
            <el-input v-model="loginForm.password" type="password" size="large" placeholder="密码" show-password @keyup.enter="handleLogin">
              <template #prefix><el-icon><Lock /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-button type="primary" class="login-btn" :loading="loginLoading" @click="handleLogin">登录</el-button>
        </el-form>
        <div class="tip-box">
          <el-icon><InfoFilled /></el-icon>
          <span>默认账号：<b>admin</b> / 密码：<b>123456</b></span>
        </div>
      </div>
    </div>
  </div>

  <!-- 主界面 -->
  <div v-else class="app-layout" @contextmenu.prevent @click="closeContextMenu">
    <header class="app-header">
      <div class="logo">
        <el-button class="collapse-btn" text size="small" @click="toggleSidebar" :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'">
          <el-icon size="18"><Expand v-if="sidebarCollapsed" /><Fold v-else /></el-icon>
        </el-button>
        <span class="logo-icon">🐬</span>
        <span>SQLAdmin</span>
        <span class="sub">· 数据库管理工具</span>
        <el-button size="small" type="primary" class="new-conn-btn" @click="openConnDialog">
          <el-icon><Connection /></el-icon><span style="margin-left:4px">新建连接</span>
        </el-button>
      </div>
      <div class="header-actions">
        <el-dropdown trigger="click" @command="handleUserCommand">
          <div class="user-info dropdown-trigger">
            <span class="user-avatar">{{ userInitial }}</span>
            <span class="user-name">{{ user.name || user.username }}</span>
            <el-icon class="caret"><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled style="color:#94A3B8">
                <el-icon><UserFilled /></el-icon>
                <span style="margin-left:6px">{{ user.name }} ({{ user.username }})</span>
              </el-dropdown-item>
              <el-dropdown-item divided command="logout">
                <el-icon><SwitchButton /></el-icon>
                <span style="margin-left:6px">退出登录</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <div class="app-body">
      <!-- 左侧库表树 -->
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <div class="sidebar-head">
          <template v-if="!sidebarCollapsed">
            <el-breadcrumb v-if="connected" class="conn-crumb" separator="/">
              <el-breadcrumb-item class="crumb-conn">
                <span class="status-dot online"></span>{{ connection.name }}
              </el-breadcrumb-item>
              <el-breadcrumb-item v-if="currentDb" class="crumb-db">{{ currentDb }}</el-breadcrumb-item>
              <el-breadcrumb-item v-if="currentTable" class="crumb-table">{{ currentTable }}</el-breadcrumb-item>
            </el-breadcrumb>
            <span v-else class="title">未连接</span>
          </template>
        </div>
        <div class="sidebar-tree">
          <div v-if="!connected" class="sidebar-empty">
            <el-icon style="font-size:34px;color:#94A3B8"><Coin /></el-icon>
            <p style="margin:10px 0 0">暂无连接</p>
            <el-button type="primary" size="small" plain @click="openConnDialog">立即连接</el-button>
          </div>
          <el-tree
            v-else
            ref="treeRef"
            :data="treeData"
            :props="treeProps"
            node-key="key"
            :load="loadNode"
            lazy
            :expand-on-click-node="false"
            :default-expanded-keys="expandedKeys"
            @node-click="onNodeClick"
          >
            <template #default="{ node, data }">
              <div
                class="tree-row"
                :class="{ 'ctx-target': data.type === 'table' || data.type === 'database' }"
                @contextmenu.prevent="onTreeContextMenu(data, $event)"
              >
                <el-icon v-if="data.type === 'database'" class="icon-db"><Coin /></el-icon>
                <el-icon v-else-if="data.type === 'table'" class="icon-table"><Document /></el-icon>
                <span class="row-label">{{ node.label }}</span>
                <span v-if="data.rows != null" class="row-meta">{{ formatRows(data.rows) }}</span>
              </div>
            </template>
          </el-tree>
        </div>
      </aside>

      <!-- 右侧主区 -->
      <main class="main-area">
        <!-- SQL 编辑器 -->
        <div class="editor-pane">
          <div class="editor-head">
            <span class="label">SQL 编辑器</span>
            <div class="spacer"></div>
            <el-button-group size="small">
              <el-button @click="formatSql"><el-icon><MagicStick /></el-icon><span style="margin-left:4px">美化</span></el-button>
              <el-button @click="clearSql"><el-icon><Delete /></el-icon><span style="margin-left:4px">清空</span></el-button>
            </el-button-group>
            <el-button size="small" type="primary" @click="runSql" :loading="loading" :disabled="!connected">
              <el-icon><CaretRight /></el-icon><span style="margin-left:4px">执行</span>
            </el-button>
            <el-button size="small" @click="runSql(true)" :loading="loading" :disabled="!connected">
              <el-icon><Select /></el-icon><span style="margin-left:4px">执行选中</span>
            </el-button>
          </div>
          <div class="editor-body">
            <textarea ref="editorRef"></textarea>
          </div>
        </div>

        <!-- 结果区 -->
        <div class="result-pane">
          <div class="result-head">
            <span class="label">结果</span>
            <span v-if="resultMeta" class="meta">{{ resultMeta }}</span>
            <div class="spacer"></div>
            <el-button v-if="hasResultRows" size="small" plain @click="exportCurrentResult">
              <el-icon><Download /></el-icon><span style="margin-left:4px">导出 CSV</span>
            </el-button>
          </div>
          <div class="result-body">
            <div v-if="!resultTabs.length && !loading" class="result-empty" :class="{ 'no-db': !currentDb }">
              <div class="empty-icon-wrap">
                <el-icon class="empty-icon"><DataAnalysis /></el-icon>
              </div>
              <span v-if="currentDb" class="empty-text">执行 SQL 或选择左侧表查看数据</span>
              <template v-else>
                <span class="empty-title">未选择数据库</span>
                <span class="empty-desc">请从左侧库表树中选择一个数据库和表</span>
              </template>
            </div>
            <el-tabs v-else-if="resultTabs.length" v-model="activeTab" class="result-tabs" type="card">
              <el-tab-pane
                v-for="(tab, i) in resultTabs"
                :key="tab.id"
                :name="tab.id"
                :label="tab.label"
                class="result-tab-pane"
              >
                <template #label>
                  <span>{{ tab.label }}</span>
                  <el-icon style="margin-left:4px;vertical-align:middle" @click.stop="closeTab(i)"><Close /></el-icon>
                </template>
                <result-table :tab="tab" :conn-id="connection.id" @export="exportTable" />
              </el-tab-pane>
            </el-tabs>
          </div>
        </div>
      </main>
    </div>

    <connection-dialog v-model:visible="connDialogVisible" @connected="onConnected" />
    <import-dialog v-model:visible="importDialog.visible" :conn="connection" :database="importDialog.database" :table="importDialog.table" :tables="importDialog.tables" @done="onImportDone" />

    <!-- 右键菜单：数据库 / 表 -->
    <ul
      v-if="contextMenu.visible"
      class="ctx-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <!-- 数据库菜单 -->
      <template v-if="contextMenu.kind === 'database'">
        <li class="ctx-item" @click="onCtxCommand('create-db')">
          <el-icon><CirclePlus /></el-icon><span>新建数据库</span>
        </li>
        <li class="ctx-divider"></li>
        <li class="ctx-item" @click="onCtxCommand('edit-db')">
          <el-icon><EditPen /></el-icon><span>编辑数据库</span>
        </li>
        <li class="ctx-item ctx-danger" @click="onCtxCommand('drop-db')">
          <el-icon><Delete /></el-icon><span>删除数据库</span>
        </li>
        <li class="ctx-divider"></li>
        <li class="ctx-item" @click="onCtxCommand('import-db')">
          <el-icon><Upload /></el-icon><span>导入 CSV</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('export-db')">
          <el-icon><Download /></el-icon><span>导出 CSV</span>
        </li>
      </template>
      <!-- 表菜单 -->
      <template v-else>
        <li class="ctx-item" @click="onCtxCommand('create')">
          <el-icon><CirclePlus /></el-icon><span>新建表</span>
        </li>
        <li class="ctx-divider"></li>
        <li class="ctx-item" @click="onCtxCommand('rename')">
          <el-icon><EditPen /></el-icon><span>重命名</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('copy')">
          <el-icon><CopyDocument /></el-icon><span>复制表</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('truncate')">
          <el-icon><DeleteFilled /></el-icon><span>清空表</span>
        </li>
        <li class="ctx-item ctx-danger" @click="onCtxCommand('drop')">
          <el-icon><Delete /></el-icon><span>删除表</span>
        </li>
        <li class="ctx-divider"></li>
        <li class="ctx-item" @click="onCtxCommand('import')">
          <el-icon><Upload /></el-icon><span>导入 CSV</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('export')">
          <el-icon><Download /></el-icon><span>导出 CSV</span>
        </li>
      </template>
    </ul>

    <!-- 新建表对话框 -->
    <create-table-dialog v-model:visible="createTableDialog.visible" :conn="connection" :database="createTableDialog.database" @done="onTableCreated" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/sql/sql.js';
import 'codemirror/addon/edit/matchbrackets.js';
import 'codemirror/addon/edit/closebrackets.js';
import 'codemirror/addon/hint/show-hint.css';
import 'codemirror/addon/hint/show-hint.js';
import 'codemirror/addon/hint/sql-hint.js';
import api from './api';
import ConnectionDialog from './components/ConnectionDialog.vue';
import ImportDialog from './components/ImportDialog.vue';
import ResultTable from './components/ResultTable.vue';
import CreateTableDialog from './components/CreateTableDialog.vue';

// ============ 登录 ============
const loggedIn = ref(false);
const user = reactive({ username: '', name: '' });
const loginForm = reactive({ username: 'admin', password: '123456' });
const loginLoading = ref(false);
const userInitial = computed(() => (user.name || user.username || 'A').charAt(0).toUpperCase());

async function handleLogin() {
  if (!loginForm.username || !loginForm.password) { ElMessage.warning('请输入用户名和密码'); return; }
  loginLoading.value = true;
  try {
    const data = await api.login(loginForm.username, loginForm.password);
    user.username = data.username;
    user.name = data.name;
    loggedIn.value = true;
    ElMessage.success(`欢迎，${data.name || data.username}`);
    // 登录后自动连接
    await nextTick();
    initEditor();
    try {
      const def = await api.getDefaultConnection();
      if (def) {
        const res = await api.connect(def);
        onConnected({ id: res.id, name: res.name, ...def });
      }
    } catch (e) {}
  } catch (e) {
    ElMessage.error(e.message || '登录失败');
  } finally {
    loginLoading.value = false;
  }
}

function handleUserCommand(cmd) {
  if (cmd === 'logout') handleLogout();
}

async function handleLogout() {
  try {
    await ElMessageBox.confirm('确定退出登录吗？', '提示', { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' });
  } catch (e) { return; }
  try { await api.logout(); } catch (e) {}
  loggedIn.value = false;
  Object.assign(user, { username: '', name: '' });
  connected.value = false;
  Object.assign(connection, { id: '', name: '', type: 'mysql' });
  databases.value = []; treeData.value = [];
  resultTabs.value = [];
  ElMessage.success('已退出登录');
}

onMounted(async () => {
  // 启动时根据 token 判断登录状态
  try {
    const data = await api.me();
    user.username = data.username;
    user.name = data.name;
    loggedIn.value = true;
    await nextTick();
    initEditor();
    // 自动用默认连接
    try {
      const def = await api.getDefaultConnection();
      if (def) {
        const res = await api.connect(def);
        onConnected({ id: res.id, name: res.name, ...def });
      }
    } catch (e) {}
  } catch (e) {
    // 未登录，显示登录页
    localStorage.removeItem('sqladmin_token');
    loggedIn.value = false;
  }
});

// ============ 编辑器 & 主逻辑 ============
const editorRef = ref(null);
let cmInstance = null;
let editorInited = false;

const connected = ref(false);
const sidebarCollapsed = ref(false);
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }
const connection = reactive({ id: '', name: '', type: 'mysql' });
const databases = ref([]);
const databaseSelect = ref('');
const currentDb = ref('');
const currentTable = ref('');
const treeData = ref([]);
const expandedKeys = ref([]);
const treeRef = ref(null);
const loading = ref(false);

const editorHeight = ref(220);
const resultTabs = ref([]);
const activeTab = ref('');
const resultMeta = ref('');
const hasResultRows = computed(() => {
  const tab = resultTabs.value.find((t) => t.id === activeTab.value);
  return !!(tab && tab.rows && tab.rows.length);
});

const connDialogVisible = ref(false);
const importDialog = reactive({ visible: false, database: '', table: '', tables: [] });
const treeProps = { label: 'label', children: 'children', isLeaf: 'isLeaf' };

function initEditor() {
  if (editorInited || !editorRef.value) return;
  editorInited = true;
  cmInstance = CodeMirror.fromTextArea(editorRef.value, {
    mode: 'text/x-mysql',
    theme: 'sqladmin',
    lineNumbers: true,
    indentUnit: 2,
    smartIndent: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    extraKeys: {
      'Ctrl-Enter': () => runSql(),
      'Cmd-Enter': () => runSql(),
      'Ctrl-Space': 'autocomplete',
      'Tab': (cm) => {
        if (cm.somethingSelected()) cm.indentSelection('add');
        else cm.replaceSelection('  ', 'end');
      }
    }
  });
  cmInstance.setValue('-- 在此输入 SQL 语句，Ctrl+Enter 执行\nSELECT VERSION();\n');
}

function openConnDialog() { connDialogVisible.value = true; }

async function onConnected(conn) {
  Object.assign(connection, conn);
  connected.value = true;
  connDialogVisible.value = false;
  await loadDatabases();
  await refreshTree();
}

async function loadDatabases() {
  try { databases.value = await api.listDatabases(connection.id); }
  catch (e) { ElMessage.error('获取数据库列表失败: ' + e.message); }
}

async function refreshTree() {
  const dbs = await api.listDatabases(connection.id);
  databases.value = dbs;
  treeData.value = dbs.map((d) => ({
    key: 'db:' + d, label: d, type: 'database', name: d, children: []
  }));
}

async function loadNode(node, resolve) {
  const data = node.data;
  if (data.type === 'database') {
    try {
      const tables = await api.listTables(connection.id, data.name);
      resolve(tables.map((t) => ({
        key: 'tb:' + data.name + '.' + t.name,
        label: t.name, type: 'table', name: t.name, database: data.name, rows: t.rows, isLeaf: true
      })));
    } catch (e) { ElMessage.error('加载表失败: ' + e.message); resolve([]); }
  } else resolve([]);
}

function onNodeClick(data) {
  if (data.type === 'database') {
    currentDb.value = data.name;
    databaseSelect.value = data.name;
    insertText(`USE \`${data.name}\`;`);
  } else if (data.type === 'table') {
    currentDb.value = data.database;
    databaseSelect.value = data.database;
    currentTable.value = data.name;
    viewTableData(data);
  }
}

function onDbChange(val) { currentDb.value = val; }

function viewTableData(data) {
  currentDb.value = data.database;
  databaseSelect.value = data.database;
  currentTable.value = data.name;
  openResultTab({
    kind: 'table', connId: connection.id, database: data.database, table: data.name, label: data.name
  });
}

function insertText(text) {
  if (!cmInstance) return;
  const cur = cmInstance.getCursor();
  cmInstance.replaceRange(text + '\n', { line: cur.line, ch: 0 }, { line: cur.line, ch: 0 });
  cmInstance.focus();
}

async function runSql(selectedOnly = false) {
  if (!connected.value) { ElMessage.warning('请先连接数据库'); return; }
  let sql = '';
  if (selectedOnly && cmInstance.getSelection()) sql = cmInstance.getSelection();
  else sql = cmInstance.getValue();
  if (!sql || !sql.trim()) { ElMessage.warning('SQL 不能为空'); return; }
  loading.value = true;
  resultMeta.value = '';
  try {
    const results = await api.query(connection.id, currentDb.value || databaseSelect.value, sql);
    if (!results.length) { ElMessage.success('执行完成'); return; }
    const tabs = results.map((r, i) => {
      if (r.type === 'select') {
        return {
          id: 'tab_' + Date.now() + '_' + i, kind: 'query',
          label: `结果 ${i + 1} (${r.rows.length} 行)`,
          columns: r.fields, rows: r.rows, affected: r.affected
        };
      } else {
        return {
          id: 'tab_' + Date.now() + '_' + i, kind: 'write',
          label: `执行 ${i + 1}`,
          columns: ['affectedRows', 'insertId', 'changedRows'],
          rows: [{ affectedRows: r.affected, insertId: r.insertId, changedRows: r.changed }],
          affected: r.affected, writeInfo: r
        };
      }
    });
    resultTabs.value = tabs;
    activeTab.value = tabs[tabs.length - 1].id;
    const sel = results.find((r) => r.type === 'select');
    if (sel) resultMeta.value = `返回 ${sel.rows.length} 行`;
    else resultMeta.value = `影响 ${results[results.length - 1].affected} 行`;
  } catch (e) { ElMessage.error('执行失败: ' + e.message); }
  finally { loading.value = false; }
}

function openResultTab(tab) {
  const id = 'tab_' + Date.now();
  tab.id = id;
  resultTabs.value = [tab];
  activeTab.value = id;
}

function closeTab(i) {
  resultTabs.value.splice(i, 1);
  if (!resultTabs.value.length) activeTab.value = '';
  else if (activeTab.value === resultTabs.value[i]?.id) activeTab.value = resultTabs.value[Math.max(0, i - 1)].id;
}

function clearSql() { if (cmInstance) cmInstance.setValue(''); }

function formatSql() {
  if (!cmInstance) return;
  const sql = cmInstance.getValue();
  if (!sql.trim()) return;
  cmInstance.setValue(simpleFormat(sql));
  ElMessage.success('已美化');
}

function simpleFormat(sql) {
  const keywords = ['SELECT','FROM','WHERE','AND','OR','ORDER BY','GROUP BY','HAVING','LIMIT','INSERT INTO','VALUES','UPDATE','SET','DELETE FROM','LEFT JOIN','RIGHT JOIN','INNER JOIN','JOIN','ON','UNION','CREATE TABLE','ALTER TABLE','DROP TABLE','SHOW','USE'];
  let s = sql.replace(/\s+/g, ' ').trim();
  for (const kw of keywords) {
    const re = new RegExp('\\b' + kw + '\\b', 'gi');
    s = s.replace(re, '\n' + kw.toUpperCase());
  }
  s = s.replace(/^\n/, '');
  s = s.replace(/,\s*/g, ',\n    ');
  return s;
}

function formatRows(n) {
  if (n == null) return '';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function exportTable(data) {
  if (!data || !data.name) return;
  const db = data.database || currentDb.value;
  const url = api.exportTableUrl(connection.id, db, data.name);
  window.open(url, '_blank');
  ElMessage.success('开始导出 ' + data.name);
}

async function exportCurrentResult() {
  const tab = resultTabs.value.find((t) => t.id === activeTab.value);
  if (!tab) return;
  try {
    if (tab.kind === 'table' && tab.connId && tab.database && tab.table) {
      const url = api.exportTableUrl(tab.connId, tab.database, tab.table);
      window.open(url, '_blank');
      return;
    }
    const sql = cmInstance && cmInstance.getValue();
    if (!sql) { ElMessage.warning('无可导出内容'); return; }
    const blob = await api.exportQueryCsv(tab.connId || connection.id, tab.database || currentDb.value, sql);
    downloadBlob(blob, 'query_result.csv');
    ElMessage.success('导出成功');
  } catch (e) { ElMessage.error('导出失败: ' + e.message); }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openImport(data) {
  importDialog.database = data.database || currentDb.value;
  importDialog.table = data.name;
  importDialog.tables = [];
  importDialog.visible = true;
}
function onImportDone() { importDialog.visible = false; refreshTree(); }

// 新建表对话框
const createTableDialog = reactive({ visible: false, database: '' });
function openCreateTableDialog(database) {
  createTableDialog.database = database || currentDb.value;
  createTableDialog.visible = true;
}
function onTableCreated() {
  createTableDialog.visible = false;
  refreshTree();
}

// 右键菜单（数据库 / 表）
const contextMenu = reactive({ visible: false, x: 0, y: 0, data: null, kind: 'table' });
function onTreeContextMenu(data, e) {
  if (data.type !== 'table' && data.type !== 'database') return;
  contextMenu.visible = true;
  contextMenu.x = e.clientX;
  contextMenu.y = e.clientY;
  contextMenu.data = data;
  contextMenu.kind = data.type;
  // 选中被右键的节点（高亮）
  if (data.key) treeRef.value?.setCurrentKey(data.key);
}
function closeContextMenu() {
  contextMenu.visible = false;
  contextMenu.data = null;
}
async function onCtxCommand(cmd) {
  const data = contextMenu.data;
  closeContextMenu();
  switch (cmd) {
    // 表操作
    case 'create': openCreateTableDialog(data ? data.database : currentDb.value); break;
    case 'import': openImport(data); break;
    case 'export': exportTable(data); break;
    case 'rename': handleRenameTable(data); break;
    case 'copy': handleCopyTable(data); break;
    case 'truncate': handleTruncateTable(data); break;
    case 'drop': handleDropTable(data); break;
    // 数据库操作
    case 'create-db': handleCreateDatabase(); break;
    case 'edit-db': handleEditDatabase(data); break;
    case 'drop-db': handleDropDatabase(data); break;
    case 'import-db': handleDatabaseImport(data); break;
    case 'export-db': handleDatabaseExport(data); break;
  }
}

// 新建数据库
async function handleCreateDatabase() {
  try {
    const res = await ElMessageBox.prompt('请输入数据库名', '新建数据库', {
      confirmButtonText: '确定', cancelButtonText: '取消',
      inputValue: '',
      inputPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
      inputErrorMessage: '库名只能以字母/下划线开头，含字母数字下划线'
    });
    const name = res.value.trim();
    await api.createDatabase(connection.id, name, 'utf8mb4');
    ElMessage.success(`数据库 ${name} 创建成功`);
    refreshTree();
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('创建失败: ' + (e.message || e));
  }
}

// 编辑数据库（修改字符集）
async function handleEditDatabase(data) {
  try {
    const info = await api.getDatabaseInfo(connection.id, data.name);
    const cur = info?.charset || 'utf8mb4';
    const res = await ElMessageBox.prompt('请输入默认字符集', `编辑数据库「${data.name}」`, {
      confirmButtonText: '确定', cancelButtonText: '取消',
      inputValue: cur,
      inputPattern: /^[A-Za-z0-9_]+$/,
      inputErrorMessage: '字符集名不合法'
    });
    const charset = res.value.trim();
    if (charset === cur) { ElMessage.info('字符集未变化'); return; }
    await api.alterDatabase(connection.id, data.name, charset);
    ElMessage.success(`数据库「${data.name}」字符集已更新为 ${charset}`);
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('编辑失败: ' + (e.message || e));
  }
}

// 删除数据库
async function handleDropDatabase(data) {
  try {
    await ElMessageBox.confirm(
      `确认删除数据库「${data.name}」？该库内所有表和数据将全部删除，不可恢复！`,
      '危险操作：删除数据库',
      { type: 'error', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
    await api.dropDatabase(connection.id, data.name);
    ElMessage.success(`数据库「${data.name}」已删除`);
    // 关闭该库下所有 tab
    resultTabs.value = resultTabs.value.filter((t) => t.database !== data.name);
    if (!resultTabs.value.find((t) => t.id === activeTab.value)) activeTab.value = resultTabs.value[0]?.id || '';
    if (currentDb.value === data.name) { currentDb.value = ''; currentTable.value = ''; }
    refreshTree();
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('删除失败: ' + (e.message || e));
  }
}

// 库级导入：加载该库表列表，让用户选择目标表
async function handleDatabaseImport(data) {
  try {
    const tables = await api.listTables(connection.id, data.name);
    if (!tables.length) { ElMessage.warning('该库下暂无表，请先新建表'); return; }
    const tableNames = tables.map((t) => t.name);
    // 用 ElMessageBox.prompt 不便选表，这里直接打开导入对话框并传入可选表列表
    importDialog.database = data.name;
    importDialog.table = '';
    importDialog.tables = tableNames;
    importDialog.visible = true;
  } catch (e) {
    ElMessage.error('加载表列表失败: ' + (e.message || e));
  }
}

// 库级导出：导出该库所有表为 CSV
async function handleDatabaseExport(data) {
  try {
    const tables = await api.listTables(connection.id, data.name);
    if (!tables.length) { ElMessage.warning('该库下暂无表可导出'); return; }
    ElMessage.success(`开始导出 ${tables.length} 张表`);
    tables.forEach((t, i) => {
      setTimeout(() => {
        const url = api.exportTableUrl(connection.id, data.name, t.name);
        const a = document.createElement('a');
        a.href = url; a.download = `${data.name}_${t.name}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      }, i * 400);
    });
  } catch (e) {
    ElMessage.error('导出失败: ' + (e.message || e));
  }
}

// 重命名表
async function handleRenameTable(data) {
  try {
    const res = await ElMessageBox.prompt('请输入新表名', `重命名「${data.name}」`, {
      confirmButtonText: '确定', cancelButtonText: '取消',
      inputValue: data.name,
      inputPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
      inputErrorMessage: '表名只能以字母/下划线开头，含字母数字下划线'
    });
    const newName = res.value.trim();
    if (newName === data.name) return;
    await api.renameTable(connection.id, data.database, data.name, newName);
    ElMessage.success(`已重命名为 ${newName}`);
    // 更新可能已打开的 tab
    resultTabs.value.forEach((t) => { if (t.database === data.database && t.table === data.name) t.table = newName; });
    refreshTree();
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('重命名失败: ' + (e.message || e));
  }
}

// 复制表
async function handleCopyTable(data) {
  try {
    const res = await ElMessageBox.prompt('请输入新表名', `复制「${data.name}」`, {
      confirmButtonText: '确定', cancelButtonText: '取消',
      inputValue: data.name + '_copy',
      inputPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
      inputErrorMessage: '表名只能以字母/下划线开头，含字母数字下划线'
    });
    const dest = res.value.trim();
    await api.copyTable(connection.id, data.database, data.name, dest);
    ElMessage.success(`已复制为 ${dest}`);
    refreshTree();
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('复制失败: ' + (e.message || e));
  }
}

// 清空表
async function handleTruncateTable(data) {
  try {
    await ElMessageBox.confirm(
      `确认清空表「${data.name}」的所有数据？该操作不可恢复！`,
      '危险操作：清空表',
      { type: 'warning', confirmButtonText: '清空', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
    await api.truncateTable(connection.id, data.database, data.name);
    ElMessage.success(`表「${data.name}」已清空`);
    refreshTree();
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('清空失败: ' + (e.message || e));
  }
}

// 删除表
async function handleDropTable(data) {
  try {
    await ElMessageBox.confirm(
      `确认删除表「${data.name}」？表结构和数据将全部删除，不可恢复！`,
      '危险操作：删除表',
      { type: 'error', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    );
    await api.dropTable(connection.id, data.database, data.name);
    ElMessage.success(`表「${data.name}」已删除`);
    // 关闭对应 tab
    resultTabs.value = resultTabs.value.filter((t) => !(t.database === data.database && t.table === data.name));
    if (!resultTabs.value.find((t) => t.id === activeTab.value)) activeTab.value = resultTabs.value[0]?.id || '';
    refreshTree();
  } catch (e) {
    if (e === 'cancel' || e?.message === 'cancel') return;
    ElMessage.error('删除失败: ' + (e.message || e));
  }
}
</script>
