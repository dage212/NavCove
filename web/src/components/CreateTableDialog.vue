<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    title="新建表"
    width="760px"
    :close-on-click-modal="false"
    @open="resetForm"
  >
    <div style="margin-bottom:12px;color:#5e6c84;font-size:13px;">
      目标库：<el-tag size="small">{{ database }}</el-tag>
    </div>
    <el-form label-width="80px" style="margin-bottom:8px">
      <el-form-item label="表名" required>
        <el-input v-model="tableName" placeholder="如：users" style="max-width:280px" />
      </el-form-item>
    </el-form>
    <div class="col-title">字段定义</div>
    <el-table :data="columns" border size="small" style="width:100%">
      <el-table-column label="#" type="index" width="44" />
      <el-table-column label="字段名" min-width="130">
        <template #default="{ row }">
          <el-input v-model="row.name" size="small" placeholder="field_name" />
        </template>
      </el-table-column>
      <el-table-column label="类型" min-width="150">
        <template #default="{ row }">
          <el-input v-model="row.type" size="small" placeholder="VARCHAR(255)" />
        </template>
      </el-table-column>
      <el-table-column label="主键" width="60" align="center">
        <template #default="{ row }">
          <el-checkbox v-model="row.pk" />
        </template>
      </el-table-column>
      <el-table-column label="可空" width="60" align="center">
        <template #default="{ row }">
          <el-checkbox v-model="row.nullable" :disabled="row.pk" />
        </template>
      </el-table-column>
      <el-table-column label="自增" width="60" align="center">
        <template #default="{ row }">
          <el-checkbox v-model="row.autoIncrement" :disabled="!row.pk" />
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="120">
        <template #default="{ row }">
          <el-input v-model="row.comment" size="small" placeholder="可选" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="64" align="center">
        <template #default="{ $index }">
          <el-button text size="small" type="danger" @click="removeCol($index)" :disabled="columns.length <= 1">
            <el-icon><Delete /></el-icon>
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div style="margin-top:8px">
      <el-button size="small" @click="addCol"><el-icon><Plus /></el-icon><span style="margin-left:4px">添加字段</span></el-button>
    </div>
    <template #footer>
      <div class="conn-dialog-footer">
        <el-button @click="$emit('update:visible', false)">取消</el-button>
        <el-button type="primary" @click="doCreate" :loading="loading">创建表</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

const props = defineProps({
  visible: Boolean,
  conn: Object,
  database: String
});
const emit = defineEmits(['update:visible', 'done']);

const tableName = ref('');
const columns = ref([]);
const loading = ref(false);

function resetForm() {
  tableName.value = '';
  columns.value = [
    { name: 'id', type: 'INT', pk: true, nullable: false, autoIncrement: true, comment: '' }
  ];
}

function addCol() {
  columns.value.push({ name: '', type: 'VARCHAR(255)', pk: false, nullable: true, autoIncrement: false, comment: '' });
}
function removeCol(idx) {
  columns.value.splice(idx, 1);
}

async function doCreate() {
  if (!tableName.value.trim()) { ElMessage.warning('请输入表名'); return; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName.value.trim())) { ElMessage.warning('表名不合法'); return; }
  const cols = columns.value.filter((c) => c.name && c.type);
  if (!cols.length) { ElMessage.warning('请至少添加一个字段'); return; }
  const dup = cols.some((c, i) => cols.findIndex((x) => x.name === c.name) !== i);
  if (dup) { ElMessage.warning('存在重复字段名'); return; }
  loading.value = true;
  try {
    const payload = cols.map((c) => ({
      name: c.name.trim(),
      type: c.type.trim(),
      nullable: c.nullable,
      pk: c.pk,
      autoIncrement: c.autoIncrement,
      comment: c.comment || ''
    }));
    await api.createTable(props.conn.id, props.database, tableName.value.trim(), payload);
    ElMessage.success(`表 ${tableName.value} 创建成功`);
    emit('done', { table: tableName.value.trim() });
  } catch (e) {
    ElMessage.error('创建失败: ' + e.message);
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.col-title { font-size: 13px; color: #111827; margin: 8px 0 6px; font-weight: 500; }
.conn-dialog-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
