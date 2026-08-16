<template>
  <div class="app-root">
    <Title-bar
      :logged-in="loggedIn"
      :sidebar-collapsed="sidebarCollapsed"
      :user="user"
      :user-initial="userInitial"
      @toggle-sidebar="toggleSidebar"
      @open-conn="openConnDialog"
      @logout="handleUserCommand('logout')"
    />
  <!-- 登录页 -->
  <div v-if="!loggedIn" class="login-page">
    <div class="login-left">
      <img v-if="loginLogoSrc" :src="loginLogoSrc" class="logo-big" alt="NavCove Logo" />
      <div v-else class="logo-big">🐬</div>
      <h1>NavCove</h1>
      <div class="sub-title">企业级数据库管理平台</div>
      <div class="features">
        <div class="ft"><span class="ft-icon"><el-icon><Coin /></el-icon></span>支持 MySQL 多数据库连接与管理</div>
        <div class="ft"><span class="ft-icon"><el-icon><Promotion /></el-icon></span>在线 SQL 编辑器 · 语法高亮 · 智能补全</div>
        <div class="ft"><span class="ft-icon"><el-icon><Edit /></el-icon></span>表数据可视化编辑 · 暂存确认 · 批量导入导出</div>
        <div class="ft"><span class="ft-icon"><el-icon><Lock /></el-icon></span>安全鉴权 · 数据操作留痕</div>
      </div>
      <div class="copyright">© 2026 NavCove · Powered by Vue 3 + Koa</div>
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
    <!-- 顶级连接选项卡条 -->
    <div v-if="connTabs.length" class="conn-tabs-bar">
      <div class="conn-tabs-scroll">
        <div
          v-for="c in connTabs"
          :key="c.id"
          class="conn-tab"
          :class="{ active: c.id === activeConnId }"
          @click="switchConnTab(c.id)"
        >
          <el-icon class="conn-tab-icon"><Coin /></el-icon>
          <span class="conn-tab-name">{{ c.name }}</span>
          <el-icon class="conn-tab-close" @click.stop="closeConnTab(c.id)"><Close /></el-icon>
        </div>
      </div>
      <el-button class="conn-tab-add" text @click="openConnDialog" title="新建连接">
        <el-icon><Plus /></el-icon>
      </el-button>
    </div>
    <div v-else class="conn-tabs-empty">
      <span class="empty-hint">尚未连接任何数据库</span>
      <el-button type="primary" size="small" @click="openConnDialog">新建连接</el-button>
    </div>

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
            :key="activeConnId"
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
                <result-table v-if="tab.kind !== 'structure-db' && tab.kind !== 'structure-table'" :tab="tab" :conn-id="connection.id" @export="exportTable" />
                <structure-view v-else :tab="tab" :conn-id="connection.id" />
              </el-tab-pane>
            </el-tabs>
          </div>
        </div>
      </main>
    </div>

    <connection-dialog v-model:visible="connDialogVisible" :init-conn="connected ? connection : null" @connected="onConnected" />
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
        <li class="ctx-item" @click="onCtxCommand('create')">
          <el-icon><CirclePlus /></el-icon><span>新建表</span>
        </li>
        <li class="ctx-divider"></li>
        <li class="ctx-item" @click="onCtxCommand('view-db-structure')">
          <el-icon><Menu /></el-icon><span>查看库结构</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('edit-db')">
          <el-icon><EditPen /></el-icon><span>编辑数据库</span>
        </li>
        <li class="ctx-item ctx-danger" @click="onCtxCommand('drop-db')">
          <el-icon><Delete /></el-icon><span>删除数据库</span>
        </li>
        <li class="ctx-divider"></li>
        <li class="ctx-item" @click="onCtxCommand('import-db')">
          <el-icon><Download /></el-icon><span>导入 CSV</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('export-db')">
          <el-icon><Upload /></el-icon><span>导出 CSV</span>
        </li>
        <li class="ctx-item" @click="onCtxCommand('export-db-sql')">
          <el-icon><Connection /></el-icon><span>导出 SQL</span>
        </li>
      </template>
      <!-- 表菜单 -->
      <template v-else>
        <li class="ctx-item" @click="onCtxCommand('view-table-structure')">
          <el-icon><Menu /></el-icon><span>查看表结构</span>
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
        <li class="ctx-item" @click="onCtxCommand('export-sql')">
          <el-icon><Connection /></el-icon><span>导出 SQL</span>
        </li>
      </template>
    </ul>

    <!-- 新建表对话框 -->
    <create-table-dialog v-model:visible="createTableDialog.visible" :conn="connection" :database="createTableDialog.database" @done="onTableCreated" />
    <!-- 新建数据库对话框 -->
    <create-database-dialog v-model:visible="createDatabaseDialog.visible" :conn="connection" @done="onDatabaseCreated" />
    <!-- 导出 SQL 对话框（表级 / 库级共用） -->
    <export-sql-dialog
      v-model:visible="exportSqlDialog.visible"
      :kind="exportSqlDialog.kind"
      :conn="connection"
      :database="exportSqlDialog.database"
      :table="exportSqlDialog.table"
      @done="onExportSqlDone"
    />
  </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed, nextTick, watch } from 'vue';
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
import CreateDatabaseDialog from './components/CreateDatabaseDialog.vue';
import ExportSqlDialog from './components/ExportSqlDialog.vue';
import StructureView from './components/StructureView.vue';
import TitleBar from './components/TitleBar.vue';

// ============ 登录 ============
const loggedIn = ref(false);
const user = reactive({ username: '', name: '' });
const loginForm = reactive({ username: 'admin', password: '123456' });
const loginLoading = ref(false);
const userInitial = computed(() => (user.name || user.username || 'A').charAt(0).toUpperCase());
const loginLogoSrc = '/icon.png';

async function handleLogin() {
  if (!loginForm.username || !loginForm.password) { ElMessage.warning('请输入用户名和密码'); return; }
  loginLoading.value = true;
  try {
    const data = await api.login(loginForm.username, loginForm.password);
    user.username = data.username;
    user.name = data.name;
    loggedIn.value = true;
    ElMessage.success(`欢迎，${data.name || data.username}`);
    // 登录后自动连接（initEditor 由 watch(editorRef) 兜底触发）
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
  connTabs.value = [];
  activeConnId.value = '';
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
    // initEditor 由下方 watch(editorRef) 兜底触发，确保 textarea 真正渲染后再初始化
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

// 多连接选项卡：每个连接一份独立状态
const connTabs = ref([]);
const activeConnId = ref('');
const curConn = computed(() => connTabs.value.find((c) => c.id === activeConnId.value) || null);

// writable computed 代理：所有对 connection/currentDb/resultTabs 等的访问自动落到当前激活的 connTab
const DEFAULT_CONN = { id: '', name: '', type: 'mysql', host: '', port: 3306, user: '', password: '' };
const connection = computed({
  get: () => (curConn.value ? curConn.value.connection : DEFAULT_CONN),
  set: (v) => { if (curConn.value) curConn.value.connection = v; }
});
const databases = computed({ get: () => curConn.value?.databases ?? [], set: (v) => { if (curConn.value) curConn.value.databases = v; } });
const databaseSelect = ref('');
const currentDb = computed({ get: () => curConn.value?.currentDb ?? '', set: (v) => { if (curConn.value) curConn.value.currentDb = v; } });
const currentTable = computed({ get: () => curConn.value?.currentTable ?? '', set: (v) => { if (curConn.value) curConn.value.currentTable = v; } });
const treeData = computed({ get: () => curConn.value?.treeData ?? [], set: (v) => { if (curConn.value) curConn.value.treeData = v; } });
const expandedKeys = computed({ get: () => curConn.value?.expandedKeys ?? [], set: (v) => { if (curConn.value) curConn.value.expandedKeys = v; } });
const resultTabs = computed({ get: () => curConn.value?.resultTabs ?? [], set: (v) => { if (curConn.value) curConn.value.resultTabs = v; } });
const activeTab = computed({ get: () => curConn.value?.activeTab ?? '', set: (v) => { if (curConn.value) curConn.value.activeTab = v; } });
const resultMeta = computed({ get: () => curConn.value?.resultMeta ?? '', set: (v) => { if (curConn.value) curConn.value.resultMeta = v; } });
const connected = computed(() => connTabs.value.length > 0 && !!curConn.value);

const sidebarCollapsed = ref(false);
function toggleSidebar() { sidebarCollapsed.value = !sidebarCollapsed.value; }
const treeRef = ref(null);
const loading = ref(false);

const editorHeight = ref(220);
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
    theme: 'navcove',
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
  // 确保正确计算尺寸（异步渲染场景下 fromTextArea 后可能高度为 0）
  setTimeout(() => { try { cmInstance && cmInstance.refresh(); } catch (e) {} }, 0);
}

// 登录状态变化时初始化编辑器（loggedIn true → DOM 渲染 textarea → nextTick 后初始化）
watch(loggedIn, (val) => {
  if (val) {
    nextTick(() => initEditor());
  } else {
    // 登出时重置编辑器状态，确保下次登录重新初始化
    editorInited = false;
    cmInstance = null;
  }
});
// 兜底：textarea 渲染后立即初始化编辑器
watch(editorRef, (el) => {
  if (el && loggedIn.value && !editorInited) {
    nextTick(() => initEditor());
  }
});

function openConnDialog() { connDialogVisible.value = true; }

// 过滤系统库（当有非系统库时优先展示业务库）
const SYSTEM_DBS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
function pickDefaultDb(dbs, preferDb) {
  if (!dbs || !dbs.length) return '';
  if (preferDb && dbs.includes(preferDb)) return preferDb;
  const userDbs = dbs.filter((d) => !SYSTEM_DBS.includes(d));
  return (userDbs[0] || dbs[0]) || '';
}

async function onConnected(conn) {
  // 保存当前 tab 的 SQL 内容（如果有）
  saveCurrentSql();
  // 创建新连接选项卡
  const newTab = {
    id: conn.id,
    name: conn.name || conn.host || `连接${connTabs.value.length + 1}`,
    connection: { ...conn },
    databases: [],
    currentDb: '',
    currentTable: '',
    treeData: [],
    expandedKeys: [],
    resultTabs: [],
    activeTab: '',
    resultMeta: '',
    sql: ''
  };
  connTabs.value.push(newTab);
  activeConnId.value = newTab.id;
  connDialogVisible.value = false;

  await loadDatabases();
  await refreshTree();

  // 连接成功后自动展示对应内容：选默认库 -> 展开 -> 显示第一张表数据
  const dbs = databases.value || [];
  if (!dbs.length) return;
  const db = pickDefaultDb(dbs, conn && conn.database);
  if (!db) return;
  currentDb.value = db;
  databaseSelect.value = db;
  const dbKey = 'db:' + db;
  // 注意：不要在拉到表之前就设置 expandedKeys，否则 el-tree 会触发 loadNode 自动加载，
  // 后面我们再用 store.append 填充就会和 loadNode 的结果重复
  await nextTick();
  // 加载该库的表
  let tables = [];
  try {
    tables = await api.listTables(connection.value.id, db);
  } catch (e) {}
  // 填充编辑器默认 SQL（根据是否有表）
  const defaultSql = tables.length
    ? `USE \`${db}\`;\nSELECT * FROM \`${tables[0].name}\` LIMIT 50;\n`
    : `USE \`${db}\`;\nSHOW TABLES;\n`;
  newTab.sql = defaultSql;
  if (cmInstance) cmInstance.setValue(defaultSql);
  // 如果有表，自动打开第一张表的数据
  if (tables.length) {
    const first = tables[0];
    currentTable.value = first.name;
    openResultTab({
      kind: 'table', connId: connection.value.id, database: db, table: first.name, label: first.name
    });
    // 关键：lazy 模式下不要给 data.children 赋值（el-tree 会和 store 内部 childNodes 重复显示）
    // 通过 store.append 把表节点直接塞进 el-tree 内部 store，并标记 loaded=true 避免后续展开时再调 loadNode
    const tree = treeRef.value;
    if (tree) {
      const dbNode = tree.getNode(dbKey);
      if (dbNode) {
        dbNode.loaded = true;
        tables.forEach((t) => {
          try {
            tree.store.append({
              key: 'tb:' + db + '.' + t.name,
              label: t.name, type: 'table', name: t.name,
              database: db, rows: t.rows, isLeaf: true
            }, dbNode);
          } catch (e) {}
        });
        // 表节点已塞入 store，现在安全展开（loaded=true，不会再触发 loadNode）
        dbNode.expanded = true;
        expandedKeys.value = [dbKey];
      }
    }
  }
}

// 保存当前 cmInstance 内容到当前 connTab.sql
function saveCurrentSql() {
  if (cmInstance && curConn.value) {
    curConn.value.sql = cmInstance.getValue();
  }
}

// 切换连接选项卡
function switchConnTab(id) {
  if (id === activeConnId.value) return;
  saveCurrentSql();
  activeConnId.value = id;
  // 切换后加载目标 tab 的 sql 到编辑器
  nextTick(() => {
    if (cmInstance && curConn.value) {
      cmInstance.setValue(curConn.value.sql || '-- 在此输入 SQL 语句，Ctrl+Enter 执行\nSELECT VERSION();\n');
    }
  });
}

// 关闭连接选项卡
function closeConnTab(id) {
  const idx = connTabs.value.findIndex((c) => c.id === id);
  if (idx < 0) return;
  // 如果要断开后端连接可以在这里调 api.disconnect(id)
  connTabs.value.splice(idx, 1);
  if (activeConnId.value === id) {
    activeConnId.value = connTabs.value[0]?.id || '';
    nextTick(() => {
      if (cmInstance && curConn.value) {
        cmInstance.setValue(curConn.value.sql || '');
      }
    });
  }
}

async function loadDatabases() {
  try { databases.value = await api.listDatabases(connection.value.id); }
  catch (e) { ElMessage.error('获取数据库列表失败: ' + e.message); }
}

async function refreshTree() {
  const dbs = await api.listDatabases(connection.value.id);
  databases.value = dbs;
  treeData.value = dbs.map((d) => ({
    key: 'db:' + d, label: d, type: 'database', name: d, children: []
  }));
}

async function loadNode(node, resolve) {
  const data = node.data;
  if (data.type === 'database') {
    try {
      const tables = await api.listTables(connection.value.id, data.name);
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
    kind: 'table', connId: connection.value.id, database: data.database, table: data.name, label: data.name
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
    const results = await api.query(connection.value.id, currentDb.value || databaseSelect.value, sql);
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

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function exportTable(data) {
  if (!data || !data.name) return;
  const db = data.database || currentDb.value;
  const url = api.exportTableUrl(connection.value.id, db, data.name);
  triggerDownload(url, `${db}_${data.name}.csv`);
  ElMessage.success('开始导出 ' + data.name);
}

async function exportCurrentResult() {
  const tab = resultTabs.value.find((t) => t.id === activeTab.value);
  if (!tab) return;
  try {
    if (tab.kind === 'table' && tab.connId && tab.database && tab.table) {
      const url = api.exportTableUrl(tab.connId, tab.database, tab.table);
      triggerDownload(url, `${tab.database}_${tab.table}.csv`);
      return;
    }
    const sql = cmInstance && cmInstance.getValue();
    if (!sql) { ElMessage.warning('无可导出内容'); return; }
    const blob = await api.exportQueryCsv(tab.connId || connection.value.id, tab.database || currentDb.value, sql);
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
async function reloadTablesOfDb(db) {
  if (!db) return;
  const dbKey = 'db:' + db;
  // 1) 清掉外部 data 里可能被手动赋值过的 children
  const dbNode = treeData.value.find((n) => n.type === 'database' && n.name === db);
  if (dbNode) dbNode.children = undefined;
  const tree = treeRef.value;
  if (!tree) return;
  // 2) 通过 el-tree 内部 Node API 重置
  const node = tree.getNode(dbKey);
  if (!node) return;
  // 关键：用 store.remove(node) 传入 node 对象本身（不是 { key }），逐个移除旧 child
  if (node.childNodes && node.childNodes.length) {
    // 拷贝一份避免遍历时数组变动
    const oldChildren = node.childNodes.slice();
    oldChildren.forEach((child) => {
      try { tree.store.remove(child); } catch (e) {}
    });
  }
  node.loaded = false;          // 让 shouldLoadData() 返回 true
  node.expanded = false;        // 先置为未展开，下一步 expand 才会真正触发 loadNode
  // 3) 重新展开触发 loadNode -> resolve(最新表列表)
  if (typeof node.expand === 'function') {
    node.expand();
  } else if (typeof node.loadData === 'function') {
    node.loadData();
  }
}

// 同步把已打开并展示中的表 Tab 结果刷新（用户能直接看到新导入的行）
async function refreshActiveTableTabsIfMatch(db, tableName) {
  if (!db) return;
  const targets = resultTabs.value.filter(
    (t) => t.kind === 'table' && t.database === db && (!tableName || t.table === tableName)
  );
  for (const t of targets) {
    try {
      const res = await api.getTableData(t.connId, t.database, t.table, 1, t.pageSize);
      const existing = resultTabs.value.find((x) => x.id === t.id);
      if (existing) Object.assign(existing, {
        rows: res.rows,
        columns: res.columns,
        total: res.total,
        page: 1
      });
    } catch (e) {}
  }
}

function onImportDone(payload) {
  const p = payload || {};
  const db = p.database || importDialog.database;
  const tbl = p.table || importDialog.table;
  importDialog.visible = false;
  // 精准刷新目标库的 children（含 rows 最新数字）
  if (db) reloadTablesOfDb(db);
  // 如果导入的是某张具体表，并且这个表的 Tab 打开了，刷新结果区
  if (tbl) refreshActiveTableTabsIfMatch(db, tbl);
}

// 新建表对话框
const createTableDialog = reactive({ visible: false, database: '' });
function openCreateTableDialog(database) {
  createTableDialog.database = database || currentDb.value;
  createTableDialog.visible = true;
}
function onTableCreated(payload) {
  const db = createTableDialog.database;
  const table = payload && payload.table;
  createTableDialog.visible = false;
  // 刷新目标库表列表（含最新 rows）
  if (db) reloadTablesOfDb(db);
  // 如果能识别出新建的表名，自动打开它的数据 Tab
  if (table) {
    currentDb.value = db;
    databaseSelect.value = db;
    currentTable.value = table;
    openResultTab({
      kind: 'table', connId: connection.value.id, database: db, table, label: table
    });
  }
}

// 新建数据库对话框
const createDatabaseDialog = reactive({ visible: false });
function openCreateDatabaseDialog() {
  createDatabaseDialog.visible = true;
}
async function onDatabaseCreated(payload) {
  const newDb = payload && payload.database;
  createDatabaseDialog.visible = false;
  // 重建顶层（因为数据库数量变化必须重新 listDatabases）
  const oldDbs = databases.value.slice();
  await loadDatabases();
  await refreshTree();
  if (!newDb) return;
  // 如果识别出新建库名，自动切过去展开
  currentDb.value = newDb;
  databaseSelect.value = newDb;
  const dbKey = 'db:' + newDb;
  try {
    const tables = await api.listTables(connection.value.id, newDb);
    const tree = treeRef.value;
    if (tree) {
      const dbNode = tree.getNode(dbKey);
      if (dbNode) {
        dbNode.loaded = true;
        tables.forEach((t) => {
          try {
            tree.store.append({
              key: 'tb:' + newDb + '.' + t.name,
              label: t.name, type: 'table', name: t.name,
              database: newDb, rows: t.rows, isLeaf: true
            }, dbNode);
          } catch (e) {}
        });
        dbNode.expanded = true;
        expandedKeys.value = Array.from(new Set([...(expandedKeys.value || []), dbKey]));
      }
    }
    if (tables.length) {
      const first = tables[0];
      currentTable.value = first.name;
      openResultTab({
        kind: 'table', connId: connection.value.id, database: newDb, table: first.name, label: first.name
      });
    } else {
      if (cmInstance) cmInstance.setValue(`USE \`${newDb}\`;\nSHOW TABLES;\n`);
    }
  } catch (e) {}
}

// 导出 SQL 对话框（表级 / 库级共用）
const exportSqlDialog = reactive({
  visible: false,
  kind: 'table',   // 'table' | 'database'
  database: '',
  table: ''
});
function openExportSqlTableDialog(data) {
  const database = data && data.database ? data.database : (data && data.name ? data.database : currentDb.value);
  const table = data && data.name ? data.name : '';
  exportSqlDialog.kind = 'table';
  exportSqlDialog.database = database;
  exportSqlDialog.table = table;
  exportSqlDialog.visible = true;
}
function openExportSqlDatabaseDialog(data) {
  exportSqlDialog.kind = 'database';
  exportSqlDialog.database = data && data.name ? data.name : currentDb.value;
  exportSqlDialog.table = '';
  exportSqlDialog.visible = true;
}
function onExportSqlDone() {
  // 导出是浏览器 <a download> 触发，不需要额外动作；留空方便扩展
}
function openDbStructureTab(data) {
  const database = (data && data.name) || currentDb.value;
  if (!database) { ElMessage.warning('未选择数据库'); return; }
  currentDb.value = database;
  const id = 'tab_' + Date.now();
  const tab = {
    id,
    kind: 'structure-db',
    database,
    label: `库结构：${database}`
  };
  resultTabs.value = [tab];
  activeTab.value = id;
}
function openTableStructureTab(data) {
  const database = data && data.database ? data.database : currentDb.value;
  const table = data && data.name ? data.name : '';
  if (!database || !table) { ElMessage.warning('未选择表'); return; }
  currentDb.value = database;
  currentTable.value = table;
  const id = 'tab_' + Date.now();
  const tab = {
    id,
    kind: 'structure-table',
    database,
    table,
    label: `表结构：${table}`
  };
  resultTabs.value = [tab];
  activeTab.value = id;
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
    case 'create': openCreateTableDialog(data ? (data.type === 'database' ? data.name : data.database) : currentDb.value); break;
    case 'import': openImport(data); break;
    case 'export': exportTable(data); break;
    case 'export-sql': openExportSqlTableDialog(data); break;
    case 'view-table-structure': openTableStructureTab(data); break;
    case 'rename': handleRenameTable(data); break;
    case 'copy': handleCopyTable(data); break;
    case 'truncate': handleTruncateTable(data); break;
    case 'drop': handleDropTable(data); break;
    // 数据库操作
    case 'create-db': openCreateDatabaseDialog(); break;
    case 'view-db-structure': openDbStructureTab(data); break;
    case 'edit-db': handleEditDatabase(data); break;
    case 'drop-db': handleDropDatabase(data); break;
    case 'import-db': handleDatabaseImport(data); break;
    case 'export-db': handleDatabaseExport(data); break;
    case 'export-db-sql': openExportSqlDatabaseDialog(data); break;
  }
}

// 新建数据库（旧的 ElMessageBox 弹窗实现已替换为 CreateDatabaseDialog，保留函数仅作兼容占位）
async function handleCreateDatabase() {
  openCreateDatabaseDialog();
}

// 编辑数据库（修改字符集）
async function handleEditDatabase(data) {
  try {
    const info = await api.getDatabaseInfo(connection.value.id, data.name);
    const cur = info?.charset || 'utf8mb4';
    const res = await ElMessageBox.prompt('请输入默认字符集', `编辑数据库「${data.name}」`, {
      confirmButtonText: '确定', cancelButtonText: '取消',
      inputValue: cur,
      inputPattern: /^[A-Za-z0-9_]+$/,
      inputErrorMessage: '字符集名不合法'
    });
    const charset = res.value.trim();
    if (charset === cur) { ElMessage.info('字符集未变化'); return; }
    await api.alterDatabase(connection.value.id, data.name, charset);
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
    await api.dropDatabase(connection.value.id, data.name);
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
    const tables = await api.listTables(connection.value.id, data.name);
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

// 库级导出：导出该库所有表为 CSV（流式，逐表串行触发）
async function handleDatabaseExport(data) {
  try {
    const tables = await api.listTables(connection.value.id, data.name);
    if (!tables.length) { ElMessage.warning('该库下暂无表可导出'); return; }
    ElMessage.success(`开始导出 ${tables.length} 张表`);
    tables.forEach((t, i) => {
      setTimeout(() => {
        const url = api.exportTableUrl(connection.value.id, data.name, t.name);
        triggerDownload(url, `${data.name}_${t.name}.csv`);
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
    await api.renameTable(connection.value.id, data.database, data.name, newName);
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
    await api.copyTable(connection.value.id, data.database, data.name, dest);
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
    await api.truncateTable(connection.value.id, data.database, data.name);
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
    await api.dropTable(connection.value.id, data.database, data.name);
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
