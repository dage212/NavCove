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
        <div class="conn-name-row">
          <el-input v-model="form.name" placeholder="例如：本机 MySQL" />
          <el-select
            v-model="selectedConnId"
            placeholder="选已存连接"
            style="width: 132px; flex-shrink: 0"
            clearable
            @change="applySavedConn"
          >
            <el-option v-for="c in savedConns" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </div>
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
        <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width:100%" class="port-input" />
      </el-form-item>
      <el-form-item label="用户名">
        <el-input v-model="form.user" placeholder="root" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input v-model="form.password" show-password placeholder="无密码可留空" />
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

const props = defineProps({
  visible: Boolean,
  // 已存在的连接对象（用于回显）；为空时用默认连接
  initConn: { type: Object, default: null }
});
const emit = defineEmits(['update:visible', 'connected']);

const form = reactive({
  id: '',
  name: '本机 MySQL',
  type: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: ''
});
const testing = ref(false);
const connecting = ref(false);

// 已保存的连接列表 + 当前选中的已保存连接 id
const savedConns = ref([]);
const selectedConnId = ref('');

async function loadSavedConns() {
  try {
    savedConns.value = (await api.listConnections()) || [];
  } catch (e) {
    savedConns.value = [];
  }
  return savedConns.value;
}

// 选择已保存的连接：直接带入其它信息（密码脱敏不留存，需要重新输入）
function applySavedConn(id) {
  selectedConnId.value = id || '';
  if (!id) return;
  // 直接用已加载的连接列表数据填充，避免额外的 getConnection 请求导致不生效
  const c = savedConns.value.find((x) => x.id === id);
  if (!c) {
    ElMessage.warning('未找到该已保存连接，请刷新后重试');
    return;
  }
  Object.assign(form, {
    id: '',
    name: c.name ?? form.name,
    type: c.type || 'mysql',
    host: c.host ?? form.host,
    port: c.port != null ? Number(c.port) : form.port,
    user: c.user ?? form.user,
    password: ''
  });
  ElMessage.info(`已带入「${c.name}」的连接信息，若原连接有密码请重新输入`);
}

watch(() => props.visible, async (v) => {
  if (v) {
    const saved = await loadSavedConns();
    // 优先用 initConn 回显（通常是当前正在使用的连接）
    if (props.initConn && (props.initConn.id || props.initConn.host)) {
      Object.assign(form, {
        // 关键：新建连接绝不能复用已有连接的 ID，否则后端会覆盖已存在连接池，
        // 导致多个页签共用一个后端连接、查询串到其它连接的库表。
        id: '',
        name: props.initConn.name || form.name,
        type: props.initConn.type || 'mysql',
        host: props.initConn.host || form.host,
        port: props.initConn.port != null ? Number(props.initConn.port) : form.port,
        user: props.initConn.user || form.user,
        // initConn 来自父组件内存对象时已含 password；若来自后端详情则 password 被脱敏（缺失）
        password: props.initConn.password != null ? props.initConn.password : ''
      });
      // 回显的是已保存连接时，同步选中对应的下拉项，避免名称去重时误拦
      const matched = saved.find((c) => c.name === (form.name || '').trim());
      selectedConnId.value = matched ? matched.id : '';
      return;
    }
    selectedConnId.value = '';
    try {
      const def = await api.getDefaultConnection();
      // 同样忽略已保存连接的 ID，保证每次连接都新建独立的连接池
      if (def) Object.assign(form, { password: '', ...def, id: '' });
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
  const n = (form.name || '').trim();
  if (!n) { ElMessage.warning('请输入连接名称'); return; }
  // 连接名称不能重复：若已存在同名连接（且不是当前从下拉选中的那条），阻止新建
  const dup = savedConns.value.find((c) => c.name === n && c.id !== selectedConnId.value);
  if (dup) {
    ElMessage.error(`连接名称「${n}」已存在，请从下拉选择该连接或修改名称`);
    return;
  }
  connecting.value = true;
  try {
    const payload = { ...form, name: n };
    // 新建/复用均不带已保存连接的 id，由后端生成独立连接池，避免多页签共用同一后端连接
    delete payload.id;
    const res = await api.connect(payload);
    ElMessage.success('连接成功');
    // 以后端生成的连接 ID 为准，避免被表单里的 ID 覆盖成已存在的连接
    emit('connected', { ...form, name: n, id: res.id });
  } catch (e) {
    ElMessage.error('连接失败: ' + e.message);
  } finally {
    connecting.value = false;
  }
}
</script>

<style scoped>
.port-input :deep(.el-input__wrapper .el-input__inner) {
  text-align: left !important;
}
.conn-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.conn-name-row .el-input {
  flex: 1;
}
</style>
