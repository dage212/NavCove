<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    title="导入 CSV"
    width="560px"
    :close-on-click-modal="false"
  >
    <div style="margin-bottom:12px;color:#5e6c84;font-size:13px;display:flex;align-items:center;gap:8px;">
      <span>目标库：<el-tag size="small">{{ database }}</el-tag></span>
      <span>目标表：
        <el-tag v-if="table && !tables.length" size="small">{{ table }}</el-tag>
        <el-select v-else v-model="selectedTable" size="small" placeholder="请选择表" style="width:160px">
          <el-option v-for="t in tables" :key="t" :label="t" :value="t" />
        </el-select>
      </span>
    </div>
    <el-upload
      drag
      :auto-upload="false"
      :show-file-list="false"
      accept=".csv"
      :on-change="onFileChange"
    >
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
      <div class="el-upload__text">将 CSV 文件拖到此处，或<em>点击选择</em></div>
      <template #tip>
        <div class="el-upload__tip">仅支持 .csv 文件，首行作为列名（需与表字段对应）</div>
      </template>
    </el-upload>
    <div v-if="fileName" style="margin-top:12px;display:flex;align-items:center;gap:8px;">
      <el-icon><Document /></el-icon>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ fileName }}</span>
      <el-button text size="small" @click="clearFile">移除</el-button>
    </div>
    <el-form style="margin-top:14px" label-width="100px">
      <el-form-item label="导入方式">
        <el-radio-group v-model="mode">
          <el-radio value="insert">INSERT 追加</el-radio>
          <el-radio value="replace">REPLACE 覆盖</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    <template #footer>
      <div class="conn-dialog-footer">
        <el-button @click="$emit('update:visible', false)">取消</el-button>
        <el-button type="primary" @click="doImport" :loading="loading" :disabled="!content || !targetTable">开始导入</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

const props = defineProps({
  visible: Boolean,
  conn: Object,
  database: String,
  table: String,
  tables: { type: Array, default: () => [] }
});
const emit = defineEmits(['update:visible', 'done']);

const content = ref('');
const fileName = ref('');
const mode = ref('insert');
const loading = ref(false);
const selectedTable = ref('');

// 实际导入目标表：固定 table 优先，否则用下拉选择
const targetTable = computed(() => (props.table && !props.tables.length ? props.table : selectedTable.value));

watch(() => props.visible, (v) => {
  if (v) {
    content.value = '';
    fileName.value = '';
    mode.value = 'insert';
    selectedTable.value = props.tables[0] || '';
  }
});

function onFileChange(file) {
  const raw = file.raw;
  if (!raw) return;
  fileName.value = file.name;
  const reader = new FileReader();
  reader.onload = (e) => {
    // 去除可能的 BOM
    let text = e.target.result;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    content.value = text;
  };
  reader.readAsText(raw, 'utf-8');
}

function clearFile() {
  content.value = '';
  fileName.value = '';
}

async function doImport() {
  if (!targetTable.value) { ElMessage.warning('请选择目标表'); return; }
  if (!content.value) { ElMessage.warning('请先选择 CSV 文件'); return; }
  if (!props.conn || !props.conn.id) { ElMessage.error('未连接数据库'); return; }
  loading.value = true;
  try {
    const res = await api.importTable(props.conn.id, props.database, targetTable.value, content.value, mode.value === 'replace');
    ElMessage.success(`导入完成，共 ${res.count} 行，影响 ${res.inserted} 行`);
    emit('done', res);
  } catch (e) {
    ElMessage.error('导入失败: ' + e.message);
  } finally {
    loading.value = false;
  }
}
</script>
