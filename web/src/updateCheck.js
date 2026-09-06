import { ElMessage, ElMessageBox, ElLoading } from 'element-plus';
import { t } from './i18n';

export async function checkAppUpdate() {
  if (!window.navcove?.updater?.check) return;
  let info;
  try {
    info = await window.navcove.updater.check();
  } catch (e) {
    return;
  }
  if (!info?.available) return;

  try {
    await ElMessageBox.confirm(
      t('update.message', { current: info.current, latest: info.latest }),
      t('update.title'),
      {
        type: 'info',
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
        closeOnClickModal: false
      }
    );
  } catch (e) {
    return;
  }

  const loading = ElLoading.service({
    lock: true,
    text: t('update.downloading'),
    background: 'rgba(0, 0, 0, 0.35)'
  });
  const offProgress = window.navcove.updater.onProgress?.((p) => {
    loading.setText(t('update.downloadingPct', { n: p }));
  });
  try {
    await window.navcove.updater.install();
  } catch (e) {
    ElMessage.error(t('update.fail', { message: e.message || e }));
  } finally {
    if (offProgress) offProgress();
    loading.close();
  }
}
