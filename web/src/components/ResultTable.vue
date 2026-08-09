<template>
  <div style="height:100%;display:flex;flex-direction:column;overflow:hidden;">
    <!-- 只读工具栏（新增行按钮 + 分页） -->
    <div v-if="tab.kind === 'table'" class="table-toolbar">
      <span class="t-label">{{ tab.database }} . {{ tab.table }}</span>
      <div style="flex:1"></div>
      <el-input-number v-model="page" :min="1" size="small" style="width:110px" @change="loadData" />
      <span style="color:var(--c-text-3);font-size:12px">/ {{ totalPages }} 页</span>
      <el-select v-model="size" size="small" style="width:100px" @change="onSizeChange">
        <el-option :value="20" label="20 条/页" />
        <el-option :value="50" label="50 条/页" />
        <el-option :value="100" label="100 条/页" />
        <el-option :value="200" label="200 条/页" />
      </el-select>
      <el-button-group size="small">
        <el-button :disabled="page <= 1" @click="goPage(1)"><el-icon><DArrowLeft /></el-icon></el-button>
        <el-button :disabled="page <= 1" @click="goPage(page - 1)"><el-icon><ArrowLeft /></el-icon></el-button>
        <el-button :disabled="page >= totalPages" @click="goPage(page + 1)"><el-icon><ArrowRight /></el-icon></el-button>
        <el-button :disabled="page >= totalPages" @click="goPage(totalPages)"><el-icon><DArrowRight /></el-icon></el-button>
      </el-button-group>
      <el-button size="small" type="success" plain :disabled="!pkColumns.length" @click="startNewRow">
        <el-icon><Plus /></el-icon><span style="margin-left:4px">新增行</span>
      </el-button>
      <el-button size="small" @click="$emit('export', { database: tab.database, name: tab.table })">
        <el-icon><Download /></el-icon><span style="margin-left:4px">导出</span>
      </el-button>
      <el-button size="small" @click="loadData"><el-icon><Refresh /></el-icon></el-button>
    </div>

    <div v-else-if="tab.kind === 'write'" class="write-info">
      <el-result icon="success" title="执行成功" :sub-title="`影响行数 ${tab.affected}`">
        <template #extra>
          <el-descriptions :column="1" border size="small" style="margin-top:8px;max-width:360px">
            <el-descriptions-item label="affectedRows">{{ tab.writeInfo.affected }}</el-descriptions-item>
            <el-descriptions-item label="insertId">{{ tab.writeInfo.insertId }}</el-descriptions-item>
            <el-descriptions-item label="changedRows">{{ tab.writeInfo.changed }}</el-descriptions-item>
          </el-descriptions>
        </template>
      </el-result>
    </div>

    <div class="table-wrap">
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
        <!-- 操作列：删除按钮（新增行/普通行均有） -->
        <el-table-column v-if="tab.kind === 'table'" label="操作" width="64" fixed>
          <template #default="{ row, $index }">
            <template v-if="row._isNew">
              <span class="state-tag st-new" title="新增行">新</span>
            </template>
            <el-button v-if="!row._isNew && pkColumns.length" text size="small" type="danger" @click="confirmDelete(row, $index)" title="删除该行">
              <el-icon><Delete /></el-icon>
            </el-button>
          </template>
        </el-table-column>
        <el-table-column
          v-for="col in columns"
          :key="col"
          :prop="col"
          :label="col"
          :min-width="colWidth(col)"
          show-overflow-tooltip
          sortable="custom"
          :class-name="colClass(col)"
        >
          <template #header>
            <div class="col-head">
              {{ col }}
              <span v-if="pkColumns.includes(col)" class="pk-badge" title="主键">PK</span>
              <span v-if="colNull(col)" class="null-mark" title="可空">?</span>
            </div>
          </template>
          <template #default="{ row, column }">
            <!-- 单元格编辑模式（点击后弹出输入框 + ✓/✗） -->
            <template v-if="isEditingCell(row, col)">
              <div class="cell-editor">
                <el-input
                  ref="cellInputRef"
                  v-model="editingCell.value"
                  :placeholder="(row[col] == null) ? '(NULL)' : ''"
                  size="small"
                  class="edit-input"
                  :disabled="isPk(col) && !row._isNew"
                  @keyup.enter="confirmEdit"
                  @keyup.esc="cancelEdit"
                />
                <div class="cell-actions">
                  <el-button size="small" type="success" text @click="confirmEdit" title="确认修改">
                    <el-icon><Check /></el-icon>
                  </el-button>
                  <el-button size="small" type="danger" text @click="cancelEdit" title="放弃修改">
                    <el-icon><Close /></el-icon>
                  </el-button>
                </div>
              </div>
            </template>
            <!-- 新增行：✓/✗ 放在最后一列（用操作列位置，这里放列内操作按钮） -->
            <template v-else-if="row._isNew && col === newRowActionsCol">
              <div class="new-row-actions">
                <el-button size="small" type="success" :loading="newRowSubmitting" @click="confirmNewRow" title="确认新增">
                  <el-icon><Check /></el-icon><span style="margin-left:2px">确认</span>
                </el-button>
                <el-button size="small" type="danger" :disabled="newRowSubmitting" @click="cancelNewRow" title="放弃新增">
                  <el-icon><Close /></el-icon><span style="margin-left:2px">取消</span>
                </el-button>
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
      </el-table>
    </div>
    <div v-if="tab.kind === 'table'" class="table-footer">
      <template v-if="!pkColumns.length">
        <span style="color:#e6a23c">⚠ 该表无主键，无法进行单行编辑 / 新增 / 删除</span>
        <span style="margin-left:auto;color:var(--c-text-3)">点击单元格可查看内容</span>
      </template>
      <template v-else>
        <span style="color:var(--c-text-3)">点击单元格即可编辑；行尾「+新增行」后在表头顶浮动行填入并确认</span>
        <span style="margin-left:auto;color:var(--c-text-3)">共 <b>{{ total }}</b> 条记录，当前第 {{ page }} / {{ totalPages }} 页</span>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import api from '../api';

const props = defineProps({
  tab: { type: Object, required: true },
  connId: String
});
defineEmits(['export']);

const rows = ref([]);
const columns = ref([]);
const total = ref(0);
const page = ref(1);
const size = ref(50);
const sort = ref({});

// 表结构 & 主键
const columnMeta = ref([]);
const pkColumns = ref([]);

// --- 单元格编辑状态 ---
// 当有值时：{ row, col, value }
const editingCell = ref(null);
const cellInputRef = ref(null);

// --- 新增行状态 ---
const newRow = ref(null);        // { ...列值, _isNew: true }
const newRowSubmitting = ref(false);
// “确认/取消”按钮放在哪一列：最后一列（或倒数第一个非主键列）
const newRowActionsCol = computed(() => {
  if (!columns.value.length) return '';
  // 如果只有1列就放那列，否则放最后一列
  return columns.value[columns.value.length - 1];
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / size.value)));

// 实际传给 el-table 的 rows = [新增行(若存在)] + 正常行
const displayRows = computed(() => {
  if (newRow.value) return [newRow.value, ...rows.value];
  return rows.value;
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
  }
});

async function loadColumnMeta() {
  try {
    const cols = await api.tableColumns(props.connId || props.tab.connId, props.tab.database, props.tab.table);
    columnMeta.value = cols;
    pkColumns.value = cols.filter(c => c.Key === 'PRI').map(c => c.Field);
    if (columns.value.length === 0) columns.value = cols.map(c => c.Field);
  } catch (e) {
    // 容错：列结构拉不到时用已有数据的 keys 作 columns，pkColumns 留空
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
    rows.value = res.rows;
    columns.value = res.rows.length ? Object.keys(res.rows[0]) : (columns.value.length ? columns.value : columnMeta.value.map(c => c.Field));
    total.value = res.total;
  } catch (e) {
    ElMessage.error('加载数据失败: ' + e.message);
  }
}

function onSizeChange() { page.value = 1; loadData(); }
function goPage(p) { if (p < 1 || p > totalPages.value) return; page.value = p; loadData(); }
function onSort({ prop, order }) {
  if (!order) sort.value = {};
  else sort.value = { column: prop, dir: order === 'descending' ? 'desc' : 'asc' };
  page.value = 1;
  loadData();
}

function colWidth(col) {
  const samples = [...rows.value, newRow.value].filter(Boolean);
  const base = Math.max(...samples.map((r) => String(r[col] == null ? '' : r[col]).length), col.length);
  // 最后一列多给点空间放新增行的 ✓/✗
  if (newRow.value && col === newRowActionsCol.value) {
    return Math.max(base * 9 + 24, 180);
  }
  return Math.max(base * 9 + 24, 90);
}
function colClass(col) {
  if (newRow.value && col === newRowActionsCol.value) return 'col-new-actions';
  return '';
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
  if (props.tab.kind !== 'table') return false;
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
  editingCell.value = {
    row,
    col,
    value: row[col] == null ? '' : String(row[col]),
    originalValue: row[col]
  };
  nextTick(() => {
    // 聚焦
    try {
      const inputEl = document.querySelectorAll('.cell-editor .el-input__inner')[0];
      if (inputEl) { inputEl.focus(); inputEl.select(); }
    } catch (e) {}
  });
}

function confirmEdit() {
  const ec = editingCell.value;
  if (!ec) return;
  const { row, col, value, originalValue } = ec;
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
      ElMessage.success('已更新');
      editingCell.value = null;
    })
    .catch((e) => { ElMessage.error('更新失败: ' + e.message); editingCell.value && (editingCell.value.submitting = false); });
}

function cancelEdit() {
  editingCell.value = null;
}

// --- 新增行 ---
function startNewRow() {
  if (!pkColumns.value.length) {
    ElMessage.warning('该表无主键，不支持新增');
    return;
  }
  if (newRow.value) return;
  const empty = { _isNew: true };
  columnMeta.value.forEach(c => { empty[c.Field] = null; });
  // 如果 columns 里有没在 columnMeta 的字段，也补
  columns.value.forEach(c => { if (!(c in empty)) empty[c] = null; });
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
  const values = {};
  const cols = columnMeta.value.length ? columnMeta.value.map(c => c.Field) : columns.value;
  cols.forEach(c => {
    // 主键自增且为空 → 跳过让数据库生成
    if (isPk(c) && (newRow.value[c] === '' || newRow.value[c] == null)) return;
    values[c] = newRow.value[c];
  });
  if (!Object.keys(values).length) {
    ElMessage.warning('请至少填写一个字段');
    return;
  }
  newRowSubmitting.value = true;
  try {
    await api.insertRow(props.connId || props.tab.connId, props.tab.database, props.tab.table, values);
    ElMessage.success('新增成功');
    newRow.value = null;
    editingCell.value = null;
    await loadData();
  } catch (e) {
    ElMessage.error('新增失败: ' + e.message);
  } finally {
    newRowSubmitting.value = false;
  }
}

// --- 删除行 ---
async function confirmDelete(row, index) {
  if (!pkColumns.value.length) { ElMessage.warning('该表无主键，无法定位删除的行'); return; }
  if (row._isNew) {
    newRow.value = null;
    return;
  }
  const pk = {};
  pkColumns.value.forEach(c => { pk[c] = row[c]; });
  const pkShow = pkColumns.value.map(c => `${c}=${row[c]}`).join(', ');
  try {
    await ElMessageBox.confirm(`确认删除该行？(${pkShow})`, '删除确认', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    });
  } catch (e) { return; }
  try {
    const res = await api.deleteRow(props.connId || props.tab.connId, props.tab.database, props.tab.table, pk);
    ElMessage.success(`删除成功 ${res.deleted} 行`);
    await loadData();
  } catch (e) {
    ElMessage.error('删除失败: ' + e.message);
  }
}
</script>

<style scoped>
.table-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--c-border); background: #fff; flex-shrink: 0;
}
.t-label { font-size: 13px; color: var(--c-text); font-weight: 600; }
.table-wrap { flex: 1; overflow: hidden; padding: 0; }
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

/* 单元格编辑器（输入框 + ✓/✗） */
.cell-editor {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 0;
}
.cell-editor .edit-input { flex: 1; min-width: 0; }
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
  display: inline-flex; align-items: center; gap: 0; flex-shrink: 0;
  background: #fff; border: 1px solid var(--c-border); border-radius: 2px;
  padding: 0 2px;
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

/* 新增行最后一列：放确认/取消按钮 */
.new-row-actions {
  display: flex; align-items: center; gap: 6px;
  justify-content: flex-end;
}
.new-row-actions .el-button { padding: 0 8px; height: 26px; font-size: 12px; border-radius: 2px; }
:deep(.col-new-actions .cell) { display: flex; justify-content: flex-end; }

/* 操作列状态 tag & del button */
.row-ops { display: flex; align-items: center; gap: 4px; }
</style>
