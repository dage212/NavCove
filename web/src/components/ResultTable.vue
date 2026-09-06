<template>
  <div style="height:100%;display:flex;flex-direction:column;overflow:hidden;">
    <!-- 只读工具栏（新增行按钮 + 分页） -->
    <div v-if="isEditable" class="table-toolbar">
      <span class="t-label">{{ tab.database }} . {{ tab.table }}</span>
      <div style="flex:1"></div>
      <template v-if="isPaginated">
        <el-input-number v-model="page" :min="1" :max="totalPages" size="small" style="width:110px" @change="goPage(page)" />
        <span style="color:var(--c-text-3);font-size:12px">/ {{ t('table.pages', { n: totalPages }) }}</span>
        <el-select v-model="size" size="small" style="width:100px" @change="onSizeChange">
          <el-option :value="20" :label="t('table.perPage', { n: 20 })" />
          <el-option :value="50" :label="t('table.perPage', { n: 50 })" />
          <el-option :value="100" :label="t('table.perPage', { n: 100 })" />
          <el-option :value="200" :label="t('table.perPage', { n: 200 })" />
        </el-select>
        <el-button-group size="small">
          <el-button :disabled="page <= 1" @click="goPage(1)"><el-icon><DArrowLeft /></el-icon></el-button>
          <el-button :disabled="page <= 1" @click="goPage(page - 1)"><el-icon><ArrowLeft /></el-icon></el-button>
          <el-button :disabled="page >= totalPages" @click="goPage(page + 1)"><el-icon><ArrowRight /></el-icon></el-button>
          <el-button :disabled="page >= totalPages" @click="goPage(totalPages)"><el-icon><DArrowRight /></el-icon></el-button>
        </el-button-group>
      </template>
      <el-button
        v-if="!isRedis || (tab.redisType !== 'string' && tab.redisType !== 'stream')"
        size="small"
        type="success"
        plain
        :disabled="!pkColumns.length"
        @click="startNewRow"
      >
        <el-icon><Plus /></el-icon><span style="margin-left:4px">{{ t('table.addRow') }}</span>
      </el-button>
      <el-dropdown v-if="!isRedis" size="small" trigger="click" @command="onExport">
        <el-button size="small">
          <el-icon><Download /></el-icon><span style="margin-left:4px">{{ t('table.export') }}</span>
          <el-icon style="margin-left:2px"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="csv"><el-icon><Download /></el-icon>{{ t('table.exportCsv') }}</el-dropdown-item>
            <el-dropdown-item command="sql"><el-icon><Connection /></el-icon>{{ t('table.exportSql') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button size="small" @click="refreshData"><el-icon><Refresh /></el-icon></el-button>
      <template v-if="isRedis">
        <el-button size="small" :type="showRaw ? 'primary' : ''" plain @click="showRaw = !showRaw">
          {{ t('table.rawView') }}
        </el-button>
        <el-button size="small" @click="copyRaw" :disabled="!rawText">
          <el-icon><CopyDocument /></el-icon><span style="margin-left:4px">{{ t('table.copy') }}</span>
        </el-button>
      </template>
    </div>

    <div v-else-if="tab.kind === 'write'" class="write-info">
      <el-result icon="success" :title="t('table.execOk')" :sub-title="t('table.affected', { n: tab.affected })">
        <template #extra>
          <el-descriptions :column="1" border size="small" style="margin-top:8px;max-width:360px">
            <el-descriptions-item label="affectedRows">{{ tab.writeInfo.affected }}</el-descriptions-item>
            <el-descriptions-item label="insertId">{{ tab.writeInfo.insertId }}</el-descriptions-item>
            <el-descriptions-item label="changedRows">{{ tab.writeInfo.changed }}</el-descriptions-item>
          </el-descriptions>
        </template>
      </el-result>
    </div>

    <div v-if="isRedis && showRaw" class="raw-wrap">
      <pre class="raw-view">{{ rawText || t('common.empty') }}</pre>
    </div>
    <div v-else class="table-wrap">
      <el-table
        :data="displayRows"
        border
        stripe
        size="small"
        height="100%"
        class="data-table"
        :row-class-name="rowClass"
        @sort-change="onSort"
      >
        <el-table-column type="index" label="#" width="50" fixed />
        <el-table-column
          v-for="col in columns"
          :key="col"
          :prop="col"
          :label="col"
          :min-width="colWidth(col)"
          show-overflow-tooltip
          sortable="custom"
        >
          <template #header>
            <div class="col-head">
              {{ col }}
              <span v-if="!isRedis && pkColumns.includes(col)" class="pk-badge" :title="t('table.pk')">PK</span>
              <span v-if="colNull(col)" class="null-mark" :title="t('table.nullable')">?</span>
            </div>
          </template>
          <template #default="{ row }">
            <template v-if="isListIndexCell(row, col)">
              <el-input-number
                v-model="row.index"
                size="small"
                controls-position="right"
                :min="0"
                class="index-input"
              />
            </template>
            <template v-else-if="isEditingCell(row, col)">
              <div class="cell-editor">
                <el-input
                  ref="cellInputRef"
                  v-model="editDraft"
                  :placeholder="(row[col] == null) ? '(NULL)' : ''"
                  size="small"
                  class="edit-input"
                  :disabled="isPk(col) && !row._isNew && !isRedis"
                  @keyup.enter="confirmEdit"
                  @keyup.esc="cancelEdit"
                  @blur="onEditBlur"
                />
                <div v-if="!row._isNew" class="cell-actions">
                  <el-button size="small" type="success" text @click="confirmEdit" :title="t('table.confirmEdit')">
                    <el-icon><Check /></el-icon>
                  </el-button>
                  <el-button size="small" type="danger" text @click="cancelEdit" :title="t('table.cancelEdit')">
                    <el-icon><Close /></el-icon>
                  </el-button>
                </div>
              </div>
            </template>
            <!-- 普通显示（点击可编辑） -->
            <template v-else>
              <div
                class="cell-view"
                :class="{ 'is-null': row[col] == null, 'is-pk': isPk(col), 'editable': canEdit(row, col) }"
                @click="onCellClick(row, col)"
              >
                {{ row[col] == null ? 'NULL' : row[col] }}
              </div>
            </template>
          </template>
        </el-table-column>
        <el-table-column
          v-if="isEditable"
          :label="t('table.actions')"
          :width="newRow ? 140 : 64"
          fixed="right"
          class-name="col-actions"
        >
          <template #default="{ row, $index }">
            <div v-if="row._isNew" class="new-row-actions">
              <el-button size="small" type="success" :loading="newRowSubmitting" @click="confirmNewRow" :title="t('table.confirmAdd')">
                <el-icon><Check /></el-icon><span style="margin-left:2px">{{ t('table.confirm') }}</span>
              </el-button>
              <el-button size="small" type="danger" :disabled="newRowSubmitting" @click="cancelNewRow" :title="t('table.cancelAdd')">
                <el-icon><Close /></el-icon><span style="margin-left:2px">{{ t('common.cancel') }}</span>
              </el-button>
            </div>
            <el-button v-else-if="pkColumns.length" text size="small" type="danger" @click="confirmDelete(row, $index)" :title="t('table.deleteRow')">
              <el-icon><Delete /></el-icon>
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div v-if="isEditable" class="table-footer">
      <template v-if="!pkColumns.length">
        <span style="color:#e6a23c">{{ t('table.noPk') }}</span>
        <span style="margin-left:auto;color:var(--c-text-3)">{{ t('table.clickView') }}</span>
      </template>
      <template v-else>
        <span style="color:var(--c-text-3)">{{ t('table.clickEdit') }}</span>
        <span style="margin-left:auto;color:var(--c-text-3)">{{ t('table.total', { n: total }) }}{{ tab.kind === 'table' ? t('table.pageOf', { page, pages: totalPages }) : '' }}</span>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';
import { t } from '../i18n';

const props = defineProps({
  tab: { type: Object, required: true },
  connId: String
});
const emit = defineEmits(['export', 'rows-changed']);

// 导出下拉命令分发：csv / sql
function onExport(cmd) {
  emit('export', {
    database: props.tab.database,
    name: props.tab.table,
    type: cmd,
    kind: props.tab.kind,
    sql: props.tab.sql,
    connId: props.connId || props.tab.connId
  });
}

const rows = ref([]);
const columns = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(50);
const sort = ref({});

// 表结构 & 主键
const columnMeta = ref([]);
const pkColumns = ref([]);

const isRedis = computed(() => props.tab.engine === 'redis');
const showRaw = ref(false);
const rawText = ref('');

function rowsToRaw(list, type) {
  if (!list || !list.length) return '';
  if (type === 'string') return list[0].value == null ? '' : String(list[0].value);
  if (type === 'hash') {
    const o = {};
    list.forEach((r) => { o[r.field] = r.value; });
    return JSON.stringify(o, null, 2);
  }
  if (type === 'list') return JSON.stringify(list.map((r) => r.value), null, 2);
  if (type === 'set') return JSON.stringify(list.map((r) => r.value), null, 2);
  if (type === 'zset') return JSON.stringify(list.map((r) => ({ member: r.member, score: r.score })), null, 2);
  return JSON.stringify(list, null, 2);
}

async function copyRaw() {
  const text = rawText.value;
  if (!text) { ElMessage.warning(t('table.noRaw')); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    ElMessage.success(t('table.copiedRaw'));
  } catch (e) {
    ElMessage.error(t('table.copyFail', { message: e.message || e }));
  }
}
// 查询结果可编辑：kind=table 或 kind=query 且有 database+table
const isEditable = computed(() => !!(props.tab.database && props.tab.table && (props.tab.kind === 'table' || props.tab.kind === 'query')));

// --- 单元格编辑状态 ---
// 当有值时：{ row, col, originalValue }；输入内容单独放 editDraft，避免和 hash 的 value 列 / ref.value 撞名
const editingCell = ref(null);
const editDraft = ref('');
const cellInputRef = ref(null);

// --- 新增行状态 ---
const newRow = ref(null);        // { ...列值, _isNew: true }
const newRowSubmitting = ref(false);

const isPaginated = computed(() => props.tab.kind === 'table' || props.tab.kind === 'query');
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / size.value)));

// 实际传给 el-table 的 rows = [新增行(若存在)] + 正常行
const displayRows = computed(() => {
  const visibleRows = props.tab.kind === 'query'
    ? rows.value.slice((page.value - 1) * size.value, page.value * size.value)
    : rows.value;
  if (newRow.value) return [newRow.value, ...visibleRows];
  return visibleRows;
});

// 表加载时顺便拉一次列结构，便于判断主键 / 可空
onMounted(async () => {
  if (props.tab.kind === 'table') {
    await loadColumnMeta();
    loadData();
  } else {
    rows.value = props.tab.rows || [];
    columns.value = props.tab.columns || [];
    total.value = rows.value.length;
    // 查询结果标签：若有 database+table，也拉取列结构用于判断主键
    if (isEditable.value) await loadColumnMeta();
  }
});

watch(() => props.tab.id, async () => {
  editingCell.value = null;
  newRow.value = null;
  if (props.tab.kind === 'table') {
    page.value = 1; sort.value = {};
    await loadColumnMeta();
    loadData();
  } else {
    rows.value = props.tab.rows || [];
    columns.value = props.tab.columns || [];
    total.value = rows.value.length;
    if (isEditable.value) await loadColumnMeta();
  }
});

// 监听刷新信号（导入完成后由 App.vue 的 refreshActiveTableTabsIfMatch 触发）
watch(() => props.tab.refreshAt, () => {
  if (props.tab.kind === 'table') {
    page.value = 1;
    sort.value = {};
    loadData();
  }
});

function fallbackColumns() {
  if (columnMeta.value.length) return columnMeta.value.map((c) => c.Field);
  if (columns.value.length) return columns.value;
  if (isRedis.value) {
    const t = props.tab.redisType;
    if (t === 'list') return ['type', 'index', 'value'];
    if (t === 'set') return ['type', 'value'];
    if (t === 'zset') return ['type', 'member', 'score'];
    return ['type', 'field', 'value'];
  }
  return [];
}

async function loadColumnMeta() {
  try {
    const cols = await api.tableColumns(props.connId || props.tab.connId, props.tab.database, props.tab.table);
    if (cols && cols.length) {
      columnMeta.value = cols;
      pkColumns.value = cols.filter((c) => c.Key === 'PRI').map((c) => c.Field);
      if (columns.value.length === 0) columns.value = cols.map((c) => c.Field);
    } else if (!columnMeta.value.length && isRedis.value) {
      const fields = fallbackColumns();
      columnMeta.value = fields.map((f) => ({ Field: f, Key: f === 'field' || f === 'index' || f === 'member' || (f === 'value' && props.tab.redisType === 'set') ? 'PRI' : '' }));
      pkColumns.value = columnMeta.value.filter((c) => c.Key === 'PRI').map((c) => c.Field);
      if (!columns.value.length) columns.value = fields;
    }
  } catch (e) {
    // 容错：列结构拉不到时用已有数据的 keys 作 columns，pkColumns 留空
    if (!columns.value.length) columns.value = fallbackColumns();
  }
}

async function loadData() {
  if (props.tab.kind !== 'table') return;
  try {
    const res = await api.tableData(props.connId || props.tab.connId, props.tab.database, props.tab.table, {
      page: page.value,
      size: size.value,
      orderColumn: sort.value.column,
      orderDir: sort.value.dir
    });
    rows.value = res.rows || [];
    columns.value = rows.value.length ? Object.keys(rows.value[0]) : fallbackColumns();
    total.value = res.total || 0;
    rawText.value = res.raw != null && res.raw !== ''
      ? String(res.raw)
      : rowsToRaw(rows.value, res.keyType || props.tab.redisType);
  } catch (e) {
    ElMessage.error(t('table.loadFail', { message: e.message }));
  }
}

function onSizeChange() {
  page.value = 1;
  if (props.tab.kind === 'table') loadData();
  else refreshData();
}
function goPage(p) {
  if (p < 1 || p > totalPages.value) return;
  page.value = p;
  if (props.tab.kind === 'table') loadData();
  else refreshData();
}

// 刷新：kind=table 重新加载分页数据；kind=query 重新执行 SQL 更新本地数据
async function refreshData() {
  if (props.tab.kind === 'table') { await loadData(); return; }
  if (props.tab.kind === 'query' && props.tab.sql) {
    try {
      const results = await api.query(props.connId || props.tab.connId, props.tab.database, props.tab.sql);
      const sel = results.find(r => r.type === 'select');
      if (sel) {
        rows.value = sel.rows || [];
        columns.value = sel.fields || columns.value;
        total.value = rows.value.length;
        page.value = Math.min(page.value, totalPages.value);
        editingCell.value = null;
        newRow.value = null;
      }
    } catch (e) { ElMessage.error(t('table.refreshFail', { message: e.message })); }
  }
}
function onSort({ prop, order }) {
  if (!order) sort.value = {};
  else sort.value = { column: prop, dir: order === 'descending' ? 'desc' : 'asc' };
  page.value = 1;
  loadData();
}

function isListIndexCell(row, col) {
  return !!(row && row._isNew && isRedis.value && props.tab.redisType === 'list' && col === 'index');
}

function colWidth(col) {
  if (isListIndexCell(newRow.value, col)) return 120;
  const samples = [...rows.value, newRow.value].filter(Boolean);
  const base = Math.max(...samples.map((r) => String(r[col] == null ? '' : r[col]).length), col.length);
  return Math.max(base * 9 + 24, 90);
}
function rowClass({ row }) {
  if (row._isNew) return 'row-new';
  return '';
}

function isPk(col) { return pkColumns.value.includes(col); }
function colNull(col) {
  const m = columnMeta.value.find(c => c.Field === col);
  return m && m.Null === 'YES';
}

// --- 单元格点击 & 编辑 ---
function canEdit(row, col) {
  if (!isEditable.value) return false;
  if (col === 'type' || col === 'index') return false;
  if (isRedis.value) {
    if (props.tab.redisType === 'stream') return false;
    if (props.tab.redisType === 'string' && col === 'field') return false;
    return true;
  }
  if (!pkColumns.value.length) return false;
  if (row._isNew) return true;
  // 主键也允许查看但不允许修改
  if (isPk(col)) return false;
  return true;
}

function isEditingCell(row, col) {
  const ec = editingCell.value;
  if (!ec) return false;
  // 用引用对比（普通行和 newRow 引用不同，自然区分）
  return ec.row === row && ec.col === col;
}

function onCellClick(row, col) {
  if (!canEdit(row, col)) return;
  // 如果点的是正在编辑的同一个单元格，不重置
  if (isEditingCell(row, col)) return;
  if (editingCell.value && editingCell.value.row && editingCell.value.row._isNew) {
    flushPendingEdit();
  }
  editingCell.value = {
    row,
    col,
    originalValue: row[col]
  };
  editDraft.value = row[col] == null ? '' : String(row[col]);
  nextTick(() => {
    // 聚焦
    try {
      const inputEl = document.querySelectorAll('.cell-editor .el-input__inner')[0];
      if (inputEl) { inputEl.focus(); inputEl.select(); }
    } catch (e) {}
  });
}

function flushPendingEdit() {
  const ec = editingCell.value;
  if (!ec || !ec.row) return false;
  const normalized = editDraft.value === '' ? null : editDraft.value;
  if (ec.row._isNew) {
    ec.row[ec.col] = normalized;
    editingCell.value = null;
    return true;
  }
  return false;
}

function onEditBlur() {
  if (editingCell.value && editingCell.value.row && editingCell.value.row._isNew) {
    flushPendingEdit();
  }
}

function confirmEdit() {
  const ec = editingCell.value;
  if (!ec) return;
  const { row, col, originalValue } = ec;
  const value = editDraft.value;
  // 空串按 null 处理
  const normalized = value === '' ? null : value;
  // 未改变 → 直接关闭
  if (String(normalized ?? '') === String(originalValue ?? '')) {
    editingCell.value = null;
    return;
  }
  if (row._isNew) {
    // 新增行的单元格编辑直接写回，提交时一并 insert
    row[col] = normalized;
    editingCell.value = null;
    editDraft.value = '';
    return;
  }
  // 正常行：单条 update
  const pk = {};
  pkColumns.value.forEach(c => { pk[c] = row[c]; });
  const values = { [col]: normalized };
  // 临时标一下状态，避免重复提交
  editingCell.value.submitting = true;
  api.updateRow(props.connId || props.tab.connId, props.tab.database, props.tab.table, pk, values)
    .then(() => {
      row[col] = normalized;
      ElMessage.success(t('table.updated'));
      editingCell.value = null;
    })
    .catch((e) => { ElMessage.error(t('table.updateFail', { message: e.message })); editingCell.value && (editingCell.value.submitting = false); });
}

function cancelEdit() {
  editingCell.value = null;
  editDraft.value = '';
}

// --- 新增行 ---
function startNewRow() {
  if (isRedis.value && (props.tab.redisType === 'string' || props.tab.redisType === 'stream')) {
    ElMessage.warning(t('table.useNewKey'));
    return;
  }
  if (!pkColumns.value.length) {
    ElMessage.warning(t('table.noPkAdd'));
    return;
  }
  if (newRow.value) return;
  const empty = { _isNew: true };
  if (isRedis.value) empty.type = props.tab.redisType || null;
  columnMeta.value.forEach(c => { empty[c.Field] = null; });
  // 如果 columns 里有没在 columnMeta 的字段，也补
  columns.value.forEach(c => { if (!(c in empty)) empty[c] = null; });
  if (isRedis.value) empty.type = props.tab.redisType || empty.type;
  if (isRedis.value && props.tab.redisType === 'list') empty.index = total.value;
  newRow.value = empty;
  newRowSubmitting.value = false;
}

function cancelNewRow() {
  if (newRowSubmitting.value) return;
  editingCell.value = null;
  newRow.value = null;
}

async function confirmNewRow() {
  if (!newRow.value || newRowSubmitting.value) return;
  flushPendingEdit();
  const row = newRow.value;
  const values = {};
  const cols = columnMeta.value.length ? columnMeta.value.map(c => c.Field) : columns.value;
  cols.forEach(c => {
    // 主键自增且为空 → 跳过让数据库生成
    if (isPk(c) && (row[c] === '' || row[c] == null)) return;
    values[c] = row[c];
  });
  if (isRedis.value && props.tab.redisType === 'list' && row.index != null && row.index !== '') {
    values.index = Number(row.index);
  }
  if (!Object.keys(values).length) {
    ElMessage.warning(t('table.needField'));
    return;
  }
  newRowSubmitting.value = true;
  try {
    await api.insertRow(props.connId || props.tab.connId, props.tab.database, props.tab.table, values);
    ElMessage.success(t('table.addOk'));
    newRow.value = null;
    editingCell.value = null;
    // 通知左侧树更新该表行数（+1）
    if (props.tab.database && props.tab.table) {
      emit('rows-changed', { database: props.tab.database, table: props.tab.table, delta: 1 });
    }
    // kind=table: 重新加载数据；kind=query: 不重新查询，仅清空新增行表单
    if (props.tab.kind === 'table') {
      await loadData();
    }
  } catch (e) {
    ElMessage.error(t('table.addFail', { message: e.message }));
  } finally {
    newRowSubmitting.value = false;
  }
}

// --- 删除行 ---
async function confirmDelete(row, index) {
  if (!pkColumns.value.length) { ElMessage.warning(t('table.noPkDelete')); return; }
  if (row._isNew) {
    newRow.value = null;
    return;
  }
  const pk = {};
  pkColumns.value.forEach(c => { pk[c] = row[c]; });
  const pkShow = pkColumns.value.map(c => `${c}=${row[c]}`).join(', ');
  try {
    await ElMessageBox.confirm(t('table.deleteConfirm', { pk: pkShow }), t('table.deleteTitle'), {
      type: 'warning',
      confirmButtonText: t('common.delete'),
      cancelButtonText: t('common.cancel'),
      customClass: 'row-delete-confirm',
      cancelButtonClass: 'el-button--primary'
    });
  } catch (e) { return; }
  try {
    const res = await api.deleteRow(props.connId || props.tab.connId, props.tab.database, props.tab.table, pk);
    ElMessage.success(t('table.deleteOk', { n: res.deleted }));
    // 通知左侧树更新该表行数（-deleted）
    if (props.tab.database && props.tab.table) {
      emit('rows-changed', { database: props.tab.database, table: props.tab.table, delta: -res.deleted });
    }
    // kind=table: 重新加载数据；kind=query: 本地移除该行
    if (props.tab.kind === 'table') {
      await loadData();
    } else {
      const idx = rows.value.findIndex(r => r === row);
      if (idx >= 0) { rows.value.splice(idx, 1); total.value = rows.value.length; }
    }
  } catch (e) {
    ElMessage.error(t('table.deleteFail', { message: e.message }));
  }
}
</script>

<style scoped>
.table-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--c-border); background: #fff; flex-shrink: 0;
}
.t-label { font-size: 13px; color: var(--c-text); font-weight: 600; }
.table-wrap { flex: 1; min-height: 0; overflow: hidden; padding: 0; }
.raw-wrap { flex: 1; min-height: 0; overflow: auto; background: #F8FAFC; }
.raw-view {
  margin: 0; padding: 12px 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px; line-height: 1.55; color: #0F172A;
  white-space: pre-wrap; word-break: break-all;
}
.table-footer {
  padding: 6px 14px; border-top: 1px solid var(--c-border);
  color: var(--c-text-3); font-size: 12px; background: #fff;
  flex-shrink: 0; display: flex; align-items: center; gap: 14px;
}
.col-head { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
.pk-badge { background: var(--c-primary); color: #fff; font-size: 9px; padding: 0 4px; border-radius: 2px; line-height: 14px; font-weight: 600; }
.null-mark { color: var(--c-text-3); font-size: 11px; }

:deep(.null-cell) { color: var(--c-text-3); font-style: italic; }
.write-info { flex: 1; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 20px; }
:deep(.el-table .cell) { padding: 0 8px; }

/* 单元格查看态：可点击样式 */
.cell-view {
  min-height: 28px; line-height: 28px; padding: 0 2px;
  border-radius: 2px; transition: background .15s ease, box-shadow .15s ease;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cell-view.is-null { color: var(--c-text-3); font-style: italic; }
.cell-view.is-pk { font-weight: 600; color: var(--c-primary-dark); }
.cell-view.editable { cursor: text; }
.cell-view.editable:hover {
  background: #F0F7FF;
  box-shadow: 0 0 0 1px #B3D7FF inset;
}

/* 单元格编辑器：输入框占满列宽，✓/✗ 浮在输入框右侧，不挤占宽度 */
.cell-editor {
  position: relative;
  width: 100%;
  padding: 2px 0;
  overflow: visible;
}
.cell-editor .edit-input { width: 100%; }
:deep(.el-table td:has(.cell-editor)) {
  overflow: visible;
  z-index: 6;
}
:deep(.el-table td:has(.cell-editor) > .cell) {
  overflow: visible;
}
:deep(.cell-editor .edit-input .el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--c-primary) inset;
  border-radius: 2px; background: #F0F7FF;
}
:deep(.cell-editor .edit-input .el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 2px var(--c-primary) inset !important;
  background: #fff;
}
:deep(.cell-editor .edit-input .el-input__inner) { font-size: 13px; height: 28px; }
.cell-actions {
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  margin-left: 4px;
  z-index: 8;
  display: inline-flex; align-items: center; gap: 0;
  background: #fff; border: 1px solid var(--c-border); border-radius: 2px;
  padding: 0 2px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
}
.cell-actions .el-button {
  width: 22px; height: 22px; padding: 0; margin: 1px; border-radius: 2px;
}
.cell-actions .el-button:hover { background: #F0F7FF; }

/* 新增行样式：蓝色背景条 */
:deep(.el-table .row-new) { background: #F0F7FF !important; }
:deep(.el-table .row-new > td) { background: #F0F7FF !important; border-bottom: 2px dashed var(--c-primary); }
.state-tag {
  display: inline-block; width: 18px; height: 18px; border-radius: 2px;
  font-size: 11px; line-height: 18px; text-align: center; color: #fff; font-weight: 600;
}
.st-new { background: var(--c-primary-light); }
.index-input { width: 100%; padding: 2px 0; }

/* 新增行操作列（固定在右侧）：放确认/取消按钮 */
.new-row-actions {
  display: flex; align-items: center; gap: 6px;
  justify-content: center;
}
.new-row-actions .el-button { padding: 0 8px; height: 26px; font-size: 12px; border-radius: 2px; }
:deep(.col-actions .cell) { padding: 0 6px; }

/* 操作列状态 tag & del button */
.row-ops { display: flex; align-items: center; gap: 4px; }

/* 新增行固定在表头下方，不随纵向滚动 */
:deep(.el-table tr.row-new) {
  position: sticky;
  top: 0;
  z-index: 4;
}
:deep(.el-table tr.row-new > td.el-table__cell),
:deep(.el-table tr.row-new > td) {
  background: #E8F3FF !important;
}
:deep(.el-table tr.row-new:hover > td.el-table__cell),
:deep(.el-table tr.row-new:hover > td) {
  background: #E8F3FF !important;
}
</style>
