'use strict';

// The app update channel uses stable GitHub Releases with NSIS + latest.yml.
// It is deliberately separate from the Project War pre-release metadata tag.
function createLauncherUpdater(autoUpdater, notify, isPackagedWindows) {
  const state = { phase: 'idle', version: null, percent: 0 };
  let downloading = false;
  let checking = null;
  function update(partial) {
    Object.assign(state, partial);
    notify({ ...state });
    return { ...state };
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => update({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    update({ phase: 'available', version: String(info.version), percent: 0 });
    void api.download().catch(() => {});
  });
  autoUpdater.on('update-not-available', () => update({
    phase: 'up-to-date', version: null, percent: 0,
  }));
  autoUpdater.on('download-progress', (info) => update({
    phase: 'downloading', percent: Math.max(0, Math.min(100, Math.floor(info.percent || 0))),
  }));
  autoUpdater.on('update-downloaded', () => {
    downloading = false;
    update({ phase: 'downloaded', percent: 100 });
  });
  autoUpdater.on('error', (error) => {
    downloading = false;
    // Only a confirmed newer release is mandatory. Keep its version on failure
    // so a failed download cannot bypass the required update.
    update({ phase: 'error', message: String(error?.message || error) });
  });

  const api = {
    state: () => ({ ...state }),
    async check() {
      if (!isPackagedWindows) return update({ phase: 'unavailable' });
      if (checking) return checking;
      if (state.version || downloading) return { ...state };
      update({ phase: 'checking' });
      checking = (async () => {
        try { await autoUpdater.checkForUpdates(); }
        catch (error) { update({ phase: 'error', message: String(error?.message || error) }); }
        return { ...state };
      })();
      try { return await checking; } finally { checking = null; }
    },
    async ensureCurrent() {
      if (!isPackagedWindows) return;
      await api.check();
      if (state.version) throw new Error('Для запуска необходимо проверить и установить обновление лаунчера');
    },
    async retry() {
      return state.version ? api.download() : api.check();
    },
    async download() {
      if (!isPackagedWindows || !state.version || !['available', 'error'].includes(state.phase) || downloading) {
        throw new Error('Нет обновления для скачивания');
      }
      downloading = true;
      update({ phase: 'downloading', percent: 0 });
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        downloading = false;
        update({ phase: 'error', message: String(error?.message || error) });
        throw error;
      }
      return { ...state };
    },
    install() {
      if (!isPackagedWindows || state.phase !== 'downloaded') {
        throw new Error('Обновление не скачано');
      }
      autoUpdater.quitAndInstall(false, true);
    },
  };
  return api;
}

module.exports = { createLauncherUpdater };
