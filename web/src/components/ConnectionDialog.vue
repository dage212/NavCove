<template>
  <el-dialog
    :model-value="visible"
    @update:model-value="$emit('update:visible', $event)"
    title="数据库连接"
    width="460px"
    :close-on-click-modal="false"
  >
    <el-form :model="form" label-width="84px" class="conn-form">
      <el-form-item label="连接名称">
        <el-input v-model="form.name" placeholder="例如：本机 MySQL" />
      </el-form-item>
      <el-form-item label="数据库类型">
        <el-select v-model="form.type" style="width:100%">
          <el-option label="MySQL" value="mysql" />
        </el-select>
      </el-form-item>
      <el-form-item label="主机">
        <el-input v-model="form.host" placeholder="127.0.0.1" />
      </el-form-item>
      <el-form-item label="端口">
        <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width:100%" />
      </el-form-item>
      <el-form-item label="用户名">
        <el-input v-model="form.user" placeholder="root" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" show-password placeholder="无密码可留空" />
      </el-form-item>
      <el-form-item label="数据库">
        <el-input v-model="form.database" placeholder="可留空，连接后选择" />
      </el-form-item>
    </el-form>
    <template #footer>
      <div class="conn-dialog-footer">
        <el-button @click="testConn" :loading="testing">测试连接</el-button>
        <el-button @click="$emit('update:visible', false)">取消</el-button>
        <el-button type="primary" @click="confirm" :loading="connecting">连接</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, reactive, watch } from 'vue';
import { ElMessage } from 'element-plus';
import api from '../api';

const props = defineProps({ visible: Boolean });
const emit = defineEmits(['update:visible', 'connected']);

const form = reactive({ name: '本机 MySQL', type: 'mysql', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' });
const testing = ref(false);
const connecting = ref(false);

watch(() => props.visible, async (v) => {
  if (v) {
    try {
      const def = await api.getDefaultConnection();
      if (def) Object.assign(form, def);
    } catch (e) {}
  }
});

async function testConn() {
  testing.value = true;
  try {
    const res = await api.testConnection({ ...form });
    ElMessage.success(`连接成功，MySQL 版本: ${res.version}`);
  } catch (e) {
    ElMessage.error('连接失败: ' + e.message);
  } finally {
    testing.value = false;
  }
}

async function confirm() {
  connecting.value = true;
  try {
    const res = await api.connect({ ...form });
    ElMessage.success('连接成功');
    emit('connected', { id: res.id, name: res.name || form.name, ...form });
  } catch (e) {
    ElMessage.error('连接失败: ' + e.message);
  } finally {
    connecting.value = false;
  }
}
</script>
