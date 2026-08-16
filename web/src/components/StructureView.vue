<template>
  <div v-if="tab.kind === 'structure-db' || tab.kind === 'structure-table'" class="structure-view">
    <div v-loading="loading" class="sv-inner">
      <!-- 头部元信息 -->
      <div class="sv-meta">
        <template v-if="tab.kind === 'structure-db'">
          <el-tag type="primary" size="small">数据库结构</el-tag>
          <span class="sv-title">{{ info.database }}</span>
          <span v-if="info.charset" class="sv-meta-item">字符集：<b>{{ info.charset }}</b></span>
          <span v-if="info.collation" class="sv-meta-item">排序规则：<b>{{ info.collation }}</b></span>
          <span v-if="info.tables" class="sv-meta-item">表数量：<b>{{ info.tables.length }}</b></span>
        </template>
        <template v-else>
          <el-tag type="success" size="small">表结构</el-tag>
          <span class="sv-title">{{ info.database }}.{{ info.table }}</span>
          <span v-if="info.columns" class="sv-meta-item">列数：<b>{{ info.columns.length }}</b></span>
          <span v-if="info.indexes" class="sv-meta-item">索引：<b>{{ indexGroups.length }}</b> 个</span>
        </template>
        <div style="flex:1"></div>
        <el-button size="small" @click="refresh"><el-icon><Refresh /></el-icon><span style="margin-left:4px">刷新</span></el-button>
      </div>

      <!-- SQL 视图 -->
      <div class="sv-section">
        <div class="sv-sec-title">
          <el-icon><Document /></el-icon><span>SQL 定义</span>
          <el-button size="small" text @click="copyCreateSql"><el-icon><CopyDocument /></el-icon><span style="margin-left:2px">复制</span></el-button>
        </div>
        <textarea ref="sqlRef" class="sv-sql-textarea" />
      </div>

      <!-- 库结构：表列表 -->
      <div v-if="tab.kind === 'structure-db'" class="sv-section">
        <div class="sv-sec-title"><el-icon><Coin /></el-icon><span>表列表</span></div>
        <el-table :data="info.tables || []" size="small" border stripe height="260">
          <el-table-column prop="name" label="表名" min-width="180" />
          <el-table-column prop="type" label="类型" width="100" />
          <el-table-column prop="engine" label="引擎" width="100" />
          <el-table-column prop="collation" label="排序规则" width="180" />
          <el-table-column prop="createOptions" label="选项" width="180" show-overflow-tooltip />
          <el-table-column prop="comment" label="注释" min-width="160" show-overflow-tooltip />
        </el-table>
      </div>

      <!-- 表结构：列信息 -->
      <div v-else class="sv-section">
        <div class="sv-sec-title"><el-icon><Menu /></el-icon><span>列定义</span></div>
        <el-table :data="info.columns || []" size="small" border stripe height="280">
          <el-table-column prop="Field" label="字段" width="160" />
          <el-table-column prop="Type" label="类型" width="200" />
          <el-table-column label="可空" width="70" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.Null === 'YES'" size="small" type="info">YES</el-tag>
              <el-tag v-else size="small">NO</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="Key" label="键" width="80" />
          <el-table-column prop="Default" label="默认值" width="160" show-overflow-tooltip />
          <el-table-column prop="Extra" label="额外" width="140" />
          <el-table-column prop="Comment" label="注释" min-width="180" show-overflow-tooltip />
        </el-table>
      </div>

      <!-- 表结构：索引信息 -->
      <div v-if="tab.kind === 'structure-table'" class="sv-section">
        <div class="sv-sec-title"><el-icon><Connection /></el-icon><span>索引</span></div>
        <el-table :data="indexGroups" size="small" border stripe height="220">
          <el-table-column prop="name" label="索引名" width="200" />
          <el-table-column label="唯一" width="80" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.nonUnique == 0" size="small" type="success">是</el-tag>
              <el-tag v-else size="small">否</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="indexType" label="类型" width="100" />
          <el-table-column label="列" min-width="240">
            <template #default="{ row }">
              <span v-for="(c, i) in row.columns" :key="i">
                <el-tag size="small" type="info" style="margin-right:4px;">{{ c.name }}</el-tag>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="comment" label="注释" min-width="140" show-overflow-tooltip />
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Document, CopyDocument, Coin, Menu, Connection } from '@element-plus/icons-vue';
import CodeMirror from 'codemirror';
import 'codemirror/lib/codemirror.css';
import 'codemirror/mode/sql/sql.js';
import 'codemirror/addon/edit/matchbrackets.js';
import api from '../api';

const props = defineProps({
  tab: Object,
  connId: String
});

const sqlRef = ref(null);
const loading = ref(false);
const info = reactive({
  database: '',
  table: '',
  charset: null,
  collation: null,
  tables: [],
  createSql: '',
  columns: [],
  indexes: []
});

let cmInstance = null;

const indexGroups = computed(() => {
  const map = new Map();
  (info.indexes || []).forEach((r) => {
    if (!map.has(r.name)) {
      map.set(r.name, {
        name: r.name,
        nonUnique: r.nonUnique,
        indexType: r.indexType,
        comment: r.comment || '',
        columns: []
      });
    }
    const g = map.get(r.name);
    g.columns.push({ seq: r.seq, name: r.columnName, nullable: r.nullable });
  });
  return Array.from(map.values()).map((g) => {
    g.columns.sort((a, b) => Number(a.seq) - Number(b.seq));
    return g;
  });
});

async function load() {
  if (!props.connId || !props.tab) return;
  loading.value = true;
  try {
    if (props.tab.kind === 'structure-db') {
      info.database = props.tab.database || '';
      const r = await api.getDatabaseStructure(props.connId, info.database);
      Object.assign(info, r || {});
      info.database = props.tab.database || '';
    } else {
      info.database = props.tab.database || '';
      info.table = props.tab.table || '';
      const r = await api.getTableStructure(props.connId, info.database, info.table);
      Object.assign(info, r || {});
      info.database = props.tab.database || '';
      info.table = props.tab.table || '';
    }
    await nextTick();
    initCm();
    if (cmInstance) cmInstance.setValue(info.createSql || '');
  } catch (e) {
    ElMessage.error('加载结构失败：' + (e.message || e));
  } finally {
    loading.value = false;
  }
}

function initCm() {
  if (cmInstance) return;
  if (!sqlRef.value) return;
  cmInstance = CodeMirror.fromTextArea(sqlRef.value, {
    mode: 'text/x-mysql',
    theme: 'sqladmin',
    lineNumbers: true,
    indentUnit: 2,
    matchBrackets: true,
    readOnly: true,
    viewportMargin: Infinity
  });
  setTimeout(() => cmInstance && cmInstance.refresh(), 50);
}

async function refresh() {
  if (cmInstance) {
    try { cmInstance.toTextArea(); } catch (e) {}
    cmInstance = null;
  }
  await load();
}

function copyCreateSql() {
  const text = info.createSql || '';
  if (!text) { ElMessage.warning('无内容'); return; }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败');
  }
  document.body.removeChild(ta);
}

watch(() => [props.tab, props.connId], () => load(), { immediate: false });
onMounted(load);
</script>

<style scoped>
.structure-view { height:100%; overflow:auto; padding:12px; }
.sv-inner { display:flex; flex-direction:column; gap:12px; }
.sv-meta { display:flex; align-items:center; gap:10px; padding:8px 12px; background:#F0F5FF; border-radius:6px; font-size:13px; color:#4e5969; }
.sv-title { font-weight:600; color:#1D2129; font-size:14px; }
.sv-meta-item { color:#4e5969; }
.sv-meta-item b { color:#1D2129; margin:0 2px; }
.sv-section { border:1px solid #E5E6EB; border-radius:6px; overflow:hidden; }
.sv-sec-title { display:flex; align-items:center; gap:6px; padding:8px 12px; background:#FAFAFA; border-bottom:1px solid #E5E6EB; font-size:13px; color:#1D2129; font-weight:500; }
.sv-sql-textarea { display:none; }
.sv-section :deep(.CodeMirror) { height:auto; min-height:220px; max-height:420px; border:0; }
.sv-section :deep(.CodeMirror-scroll) { min-height:220px; max-height:420px; }
</style>
