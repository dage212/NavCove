<template>
  <div v-if="tab.kind === 'structure-db' || tab.kind === 'structure-table'" class="structure-view">
    <div v-loading="loading" class="sv-inner">
      <!-- 头部元信息 -->
      <div class="sv-meta">
        <template v-if="tab.kind === 'structure-db'">
          <el-tag type="primary" size="small">{{ t('structure.dbTag') }}</el-tag>
          <span class="sv-title">{{ info.database }}</span>
          <span v-if="info.charset" class="sv-meta-item">{{ t('structure.charset') }}<b>{{ info.charset }}</b></span>
          <span v-if="info.collation" class="sv-meta-item">{{ t('structure.collation') }}<b>{{ info.collation }}</b></span>
          <span v-if="info.tables" class="sv-meta-item">{{ t('structure.tableCount') }}<b>{{ info.tables.length }}</b></span>
        </template>
        <template v-else>
          <el-tag type="success" size="small">{{ t('structure.tableTag') }}</el-tag>
          <span class="sv-title">{{ info.database }}.{{ info.table }}</span>
          <span v-if="info.columns" class="sv-meta-item">{{ t('structure.colCount') }}<b>{{ info.columns.length }}</b></span>
          <span v-if="info.indexes" class="sv-meta-item">{{ t('structure.indexCount') }}<b>{{ indexGroups.length }}</b>{{ t('structure.indexUnit') }}</span>
        </template>
        <div style="flex:1"></div>
        <el-button size="small" @click="refresh"><el-icon><Refresh /></el-icon><span style="margin-left:4px">{{ t('common.refresh') }}</span></el-button>
      </div>

      <!-- SQL 视图 -->
      <div class="sv-section">
        <div class="sv-sec-title">
          <el-icon><Document /></el-icon><span>{{ t('structure.sqlDef') }}</span>
          <el-button size="small" text @click="copyCreateSql"><el-icon><CopyDocument /></el-icon><span style="margin-left:2px">{{ t('common.copy') }}</span></el-button>
        </div>
        <textarea ref="sqlRef" class="sv-sql-textarea" />
      </div>

      <!-- 库结构：表列表 -->
      <div v-if="tab.kind === 'structure-db'" class="sv-section">
        <div class="sv-sec-title"><el-icon><Coin /></el-icon><span>{{ t('structure.tableList') }}</span></div>
        <el-table :data="info.tables || []" size="small" border stripe height="260">
          <el-table-column prop="name" :label="t('structure.tableName')" min-width="180" />
          <el-table-column prop="type" :label="t('structure.type')" width="100" />
          <el-table-column prop="engine" :label="t('structure.engine')" width="100" />
          <el-table-column prop="collation" :label="t('structure.collation')" width="180" />
          <el-table-column prop="createOptions" :label="t('structure.options')" width="180" show-overflow-tooltip />
          <el-table-column prop="comment" :label="t('structure.comment')" min-width="160" show-overflow-tooltip />
        </el-table>
      </div>

      <!-- 表结构：列信息 -->
      <div v-else class="sv-section">
        <div class="sv-sec-title"><el-icon><Menu /></el-icon><span>{{ t('structure.columns') }}</span></div>
        <el-table :data="info.columns || []" size="small" border stripe height="280">
          <el-table-column prop="Field" :label="t('structure.field')" width="160" />
          <el-table-column prop="Type" :label="t('structure.type')" width="200" />
          <el-table-column :label="t('structure.nullable')" width="70" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.Null === 'YES'" size="small" type="info">YES</el-tag>
              <el-tag v-else size="small">NO</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="Key" :label="t('structure.key')" width="80" />
          <el-table-column prop="Default" :label="t('structure.default')" width="160" show-overflow-tooltip />
          <el-table-column prop="Extra" :label="t('structure.extra')" width="140" />
          <el-table-column prop="Comment" :label="t('structure.comment')" min-width="180" show-overflow-tooltip />
        </el-table>
      </div>

      <!-- 表结构：索引信息 -->
      <div v-if="tab.kind === 'structure-table'" class="sv-section">
        <div class="sv-sec-title"><el-icon><Connection /></el-icon><span>{{ t('structure.indexes') }}</span></div>
        <el-table :data="indexGroups" size="small" border stripe height="220">
          <el-table-column prop="name" :label="t('structure.indexName')" width="200" />
          <el-table-column :label="t('structure.unique')" width="80" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.nonUnique == 0" size="small" type="success">{{ t('common.yes') }}</el-tag>
              <el-tag v-else size="small">{{ t('common.no') }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="indexType" :label="t('structure.type')" width="100" />
          <el-table-column :label="t('structure.cols')" min-width="240">
            <template #default="{ row }">
              <span v-for="(c, i) in row.columns" :key="i">
                <el-tag size="small" type="info" style="margin-right:4px;">{{ c.name }}</el-tag>
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="comment" :label="t('structure.comment')" min-width="140" show-overflow-tooltip />
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
import { t } from '../i18n';

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
    ElMessage.error(t('structure.loadFail', { message: e.message || e }));
  } finally {
    loading.value = false;
  }
}

function initCm() {
  if (cmInstance) return;
  if (!sqlRef.value) return;
  cmInstance = CodeMirror.fromTextArea(sqlRef.value, {
    mode: 'text/x-mysql',
    theme: 'navcove',
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
  if (!text) { ElMessage.warning(t('structure.noContent')); return; }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    ElMessage.success(t('structure.copied'));
  } catch {
    ElMessage.error(t('structure.copyFail'));
  }
  document.body.removeChild(ta);
}

watch(() => [props.tab, props.connId], () => load(), { immediate: false });
onMounted(load);
</script>

<style scoped>
.structure-view { height:100%; overflow:auto; padding:12px; }
.sv-inner { display:flex; flex-direction:column; gap:12px; }
.sv-meta { display:flex; align-items:center; gap:10px; padding:8px 12px; background:#F1F5F9; border-radius:6px; font-size:13px; color:#64748B; }
.sv-title { font-weight:600; color:#111827; font-size:14px; }
.sv-meta-item { color:#64748B; }
.sv-meta-item b { color:#111827; margin:0 2px; }
.sv-section { border:1px solid #E5E7EB; border-radius:6px; overflow:hidden; }
.sv-sec-title { display:flex; align-items:center; gap:6px; padding:8px 12px; background:#FAFAFA; border-bottom:1px solid #E5E7EB; font-size:13px; color:#111827; font-weight:500; }
.sv-sql-textarea { display:none; }
.sv-section :deep(.CodeMirror) { height:auto; min-height:220px; max-height:420px; border:0; }
.sv-section :deep(.CodeMirror-scroll) { min-height:220px; max-height:420px; }
</style>
