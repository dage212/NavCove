<template>
  <div class="title-bar" :class="{ 'is-mac': isMac, 'is-fullscreen': isFullscreen }">
    <div class="tb-left">
      <img v-if="iconSrc" :src="iconSrc" class="tb-icon" alt="logo" />
      <span class="tb-title">NavCove</span>

      <!-- 仅主界面显示：折叠按钮 -->
      <template v-if="loggedIn">
        <el-button class="tb-collapse-btn" text size="small" @click.stop="onToggleSidebar" :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'">
          <el-icon size="16"><Expand v-if="sidebarCollapsed" /><Fold v-else /></el-icon>
        </el-button>
      </template>
    </div>

    <div class="tb-right">
      <!-- 仅主界面显示：用户下拉 -->
      <template v-if="loggedIn">
        <el-dropdown trigger="click" @command="onUserCommand">
          <div class="user-info dropdown-trigger">
            <span class="user-avatar">{{ userInitial }}</span>
            <span class="user-name">{{ user.name || user.username }}</span>
            <el-icon class="caret"><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled style="color:#94A3B8">
                <el-icon><UserFilled /></el-icon>
                <span style="margin-left:6px">{{ user.name }} ({{ user.username }})</span>
              </el-dropdown-item>
              <el-dropdown-item divided command="view-log">
                <el-icon><Document /></el-icon>
                <span style="margin-left:6px">查看日志</span>
              </el-dropdown-item>
              <el-dropdown-item divided command="logout">
                <el-icon><SwitchButton /></el-icon>
                <span style="margin-left:6px">退出登录</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>

      <!-- 窗口控制按钮（Windows/Linux 显示；macOS 用原生交通灯，不渲染） -->
      <div v-if="!isMac" class="tb-actions">
        <button class="tb-btn tb-min" title="最小化" @click.stop="onMinimize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="tb-btn tb-max" :title="isMax ? '还原' : '最大化'" @click.stop="onMaximize">
          <svg v-if="!isMax" width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>
          <svg v-else width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>
            <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>
          </svg>
        </button>
        <button class="tb-btn tb-close" title="关闭" @click.stop="onClose">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0,0 L10,10 M10,0 L0,10" stroke="currentColor" stroke-width="1.2"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { Expand, Fold, ArrowDown, UserFilled, SwitchButton, Document } from '@element-plus/icons-vue';

defineProps({
  loggedIn: { type: Boolean, default: false },
  sidebarCollapsed: { type: Boolean, default: false },
  user: { type: Object, default: () => ({ username: '', name: '' }) },
  userInitial: { type: String, default: '' }
});

const emit = defineEmits(['toggle-sidebar', 'open-conn', 'logout', 'view-log']);

// 平台判断：macOS 用原生交通灯按钮，不渲染自定义窗口控制
const isMac = computed(() => {
  const p = window.navcove?.platform || (navigator.userAgent.includes('Mac') ? 'darwin' : '');
  return p === 'darwin';
});

const isMax = ref(false);
const isFullscreen = ref(false);
const iconSrc = '/icon.png';
let offMaxChange = null;
let offFullscreenChange = null;

onMounted(async () => {
  if (window.navcove?.window) {
    try {
      isMax.value = await window.navcove.window.isMaximized();
      offMaxChange = window.navcove.window.onMaximizeChange((val) => { isMax.value = val; });
      isFullscreen.value = await window.navcove.window.isFullscreen();
      offFullscreenChange = window.navcove.window.onFullscreenChange((val) => { isFullscreen.value = val; });
    } catch (e) {}
  }
});

onUnmounted(() => {
  if (offMaxChange) offMaxChange();
  if (offFullscreenChange) offFullscreenChange();
});

function onToggleSidebar() { emit('toggle-sidebar'); }
function onUserCommand(cmd) {
  if (cmd === 'logout') emit('logout');
  else if (cmd === 'view-log') emit('view-log');
}
function onMinimize() { window.navcove?.window?.minimize?.(); }
function onMaximize() { window.navcove?.window?.maximize?.(); }
function onClose()    { window.navcove?.window?.close?.(); }
</script>

<style scoped>
.title-bar {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #007AFF;
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  color: #fff;
}
.tb-left, .tb-right {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 12px;
}
.tb-right { padding-left: 0; padding-right: 0; }
/* macOS 原生交通灯按钮在左侧，留出空间避免遮挡 logo/标题；全屏时交通灯隐藏，去掉偏移 */
.title-bar.is-mac .tb-left { padding-left: 80px; }
.title-bar.is-mac.is-fullscreen .tb-left { padding-left: 12px; }
.tb-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  flex-shrink: 0;
}
.tb-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  color: #fff;
}
.tb-collapse-btn {
  color: #fff !important;
  margin-left: 8px;
  -webkit-app-region: no-drag;
}
.tb-collapse-btn:hover {
  background: rgba(255,255,255,0.15) !important;
}

/* 用户下拉 */
.user-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 6px;
  border-radius: 18px;
  cursor: pointer;
  transition: background .15s;
  -webkit-app-region: no-drag;
}
.user-info:hover { background: rgba(255,255,255,0.15); }
.user-avatar {
  width: 26px; height: 26px; border-radius: 50%;
  background: #fff; color: #007AFF;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700;
}
.user-name { font-size: 12px; color: #fff; }
.caret { font-size: 10px; opacity: .9; color: #fff; }

/* 窗口控制按钮 */
.tb-actions {
  display: flex;
  -webkit-app-region: no-drag;
  margin-left: 6px;
}
.tb-btn {
  width: 46px;
  height: 40px;
  border: none;
  background: transparent;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.tb-btn:hover { background: rgba(255,255,255,0.15); }
.tb-close:hover { background: #E81123; }
.tb-btn:active { background: rgba(255,255,255,0.25); }
.tb-close:active { background: #F1707A; }
</style>
