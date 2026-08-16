<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    :title="dialogTitle"
    width="420px"
    :close-on-click-modal="false"
    @open="onOpen"
    @closed="onClosed"
    destroy-on-close
  >
    <el-form label-width="1px" class="export-sql-form">
      <div style="font-size:13px;color:#64748B;margin-bottom:10px;">
        <span v-if="kind === 'database'">导出范围：</span>
        <span v-else>导出表：</span>
        <el-tag size="small" style="margin-left:6px;">{{ scopeLabel }}</el-tag>
      </div>
      <el-form-item>
        <el-checkbox v-model="withSchema" :disabled="kind === 'database'" :indeterminate="indeterminate" @change="onCheckChange">
          表结构（CREATE TABLE）
        </el-checkbox>
      </el-form-item>
      <el-form-item>
        <el-checkbox v-model="withData" :indeterminate="indeterminate" @change="onCheckChange">
          数据（INSERT 语句）
        </el-checkbox>
      </el-form-item>
      <el-form-item label=" " label-width="1px" style="margin-bottom:0;">
        <el-input-number
          v-model="exportLimit"
          :min="0" :max="1000000" :step="100"
          style="width:180px;"
          controls-position="right"
          size="default"
        />
        <span style="margin-left:8px;color:#86909c;font-size:12px;">导出行数（0 = 全部）</span>
      </el-form-item>
      <div v-if="tip" style="margin-top:8px;padding:8px 12px;background:#fff7e8;color:#8a5a00;border-radius:4px;font-size:12px;">
        {{ tip }}
      </div>
    </el-form>
    <template #footer>
      <div class="conn-dialog-footer">
        <el-button @click="$emit('update:visible', false)">取消</el-button>
        <el-button type="primary" :disabled="!canExport" @click="runExport">
          <el-icon><Download /></el-icon>
          <span style="margin-left:4px">开始导出</span>
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Download } from '@element-plus/icons-vue';
import api from '../api';

const props = defineProps({
  visible: Boolean,
  // 'table' | 'database'
  kind: { type: String, default: 'table' },
  conn: Object,
  database: String,
  // 表级导出时指定
  table: { type: String, default: '' }
});
const emit = defineEmits(['update:visible', 'done']);

const withSchema = ref(true);
const withData = ref(true);
const exportLimit = ref(0);

const indeterminate = computed(() => !withSchema.value && !withData.value);
const canExport = computed(() => withSchema.value || withData.value);
const tip = computed(() => {
  if (!withSchema.value && !withData.value) return '请至少勾选一项（结构或数据）';
  if (!withSchema.value) return '仅导出数据：不包含建表语句，导入时必须先有表结构';
  if (!withData.value) return '仅导出结构：不包含 INSERT 数据，导入后表为空';
  return '两项都勾选：导出 CREATE TABLE 结构 + INSERT 数据，可直接用该 .sql 文件完整还原';
});

const dialogTitle = computed(() => props.kind === 'database' ? '导出数据库 SQL' : '导出表 SQL');
const scopeLabel = computed(() => {
  if (props.kind === 'database') return `\`${props.database || ''}\``;
  return `\`${props.database || ''}\`.\`${props.table || ''}\``;
});

function onOpen() {
  // 每次打开默认都选中
  withSchema.value = true;
  withData.value = true;
  exportLimit.value = 1000;
}
function onClosed() {}
function onCheckChange() {
  // 取消 indeterminate 的视觉状态（其实已经由 computed 计算，这里仅保留槽位以便扩展）
}

// 同 App.vue triggerDownload：隐藏 a 标签 click 下载
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  a.target = '_self';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 200);
}

async function runExport() {
  if (!props.conn || !props.conn.id) { ElMessage.error('未连接数据库'); return; }
  if (!canExport.value) return;
  const opts = {
    withSchema: withSchema.value,
    withData: withData.value,
    limit: exportLimit.value
  };
  try {
    let url;
    let filename;
    if (props.kind === 'database') {
      if (!props.database) { ElMessage.error('未指定数据库'); return; }
      url = api.exportSqlDatabaseUrl(props.conn.id, props.database, opts);
      filename = `${props.database}.sql`;
    } else {
      if (!props.database || !props.table) { ElMessage.error('未指定表'); return; }
      url = api.exportSqlTableUrl(props.conn.id, props.database, props.table, opts);
      filename = `${props.database}_${props.table}.sql`;
    }
    triggerDownload(url, filename);
    emit('done', { kind: props.kind, database: props.database, table: props.table, opts });
    emit('update:visible', false);
  } catch (e) {
    ElMessage.error('导出失败：' + (e.message || e));
  }
}
</script>

<style scoped>
.export-sql-form { padding: 4px 4px 0 0; }
.conn-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
