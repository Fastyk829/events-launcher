import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleAlert, LoaderCircle, Play, RotateCcw, Settings, Trash2, Upload, User, X } from 'lucide-react';
import { events } from '../shared/events';
import type { LauncherSettings, LauncherUpdate, RuntimeState, SkinLibrarySnapshot } from './events-api';
import { SkinPreview3D } from './SkinPreview3D';
import './style.css';

const initialState: RuntimeState = {
  phase: 'idle',
  detail: '',
  error: null,
  packConfigured: false,
  packInstalled: false,
  packUpdateAvailable: false,
};

const initialSkins: SkinLibrarySnapshot = { activeId: null, skins: [] };

const initialUpdate: LauncherUpdate = {
  phase: 'idle', version: null, percent: 0,
};

function formatGb(mb: number): string {
  return (mb / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ГБ';
}

function getDownloadStageTitle(detail: string): string {
  if (!detail) return 'Подготовка…';
  const colonIndex = detail.indexOf(':');
  if (colonIndex > 0) {
    return detail.slice(0, colonIndex).trim();
  }
  return detail;
}

function getDownloadMeta(progress?: RuntimeState['downloadProgress']): string | null {
  if (!progress) return null;
  const parts: string[] = [];
  if (progress.bytesText) {
    parts.push(progress.bytesText);
  } else if (progress.total > 0) {
    const dMb = (progress.downloaded / (1024 * 1024)).toFixed(1);
    const tMb = (progress.total / (1024 * 1024)).toFixed(1);
    parts.push(`${dMb} / ${tMb} МБ`);
  }
  if (progress.speed) parts.push(progress.speed);
  if (progress.eta) parts.push(progress.eta);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function App() {
  const [state, setState] = useState<RuntimeState>(initialState);
  const [settings, setSettings] = useState<LauncherSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nicknameRequired, setNicknameRequired] = useState(false);
  const nicknameInput = useRef<HTMLInputElement>(null);
  const [draftNickname, setDraftNickname] = useState('');
  const [draftMemoryMb, setDraftMemoryMb] = useState(4096);
  const [draftGpuPreference, setDraftGpuPreference] = useState<LauncherSettings['gpuPreference']>('automatic');
  const [draftJvmArguments, setDraftJvmArguments] = useState('');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [requestBusy, setRequestBusy] = useState(false);
  const [launcherUpdate, setLauncherUpdate] = useState<LauncherUpdate>(initialUpdate);
  const [skins, setSkins] = useState<SkinLibrarySnapshot>(initialSkins);
  const [defaultSkinModel, setDefaultSkinModel] = useState<'default' | 'slim'>('default');
  const [defaultSteve, setDefaultSteve] = useState<string | null>(null);
  const [skinBusy, setSkinBusy] = useState(false);
  const [skinError, setSkinError] = useState<string | null>(null);


  const selected = events[0]!;
  const projectWarSelected = selected.id === 'project-war';
  const busy = requestBusy || ['checking-pack', 'installing', 'installing-pack', 'launching'].includes(state.phase);
  const ready = state.phase === 'ready';
  const running = state.phase === 'running';
  const updateRequired = Boolean(launcherUpdate.version);
  const nicknameValid = draftNickname === '' || /^[A-Za-z0-9_]{3,16}$/.test(draftNickname);
  const statusVisible = Boolean(state.error) || state.packUpdateAvailable ||
    ['checking-pack', 'installing', 'installing-pack', 'launching', 'running'].includes(state.phase);

  useEffect(() => {
    let mounted = true;
    const unsubscribeUpdate = window.eventsLauncher.onLauncherUpdate((next) => {
      if (mounted) setLauncherUpdate(next);
    });
    void window.eventsLauncher.launcherUpdateState().then((next) => {
      if (mounted) setLauncherUpdate(next);
    }).catch(console.error);
    const unsubscribe = window.eventsLauncher.onProgress((next) => {
      if (mounted) setState(next);
    });
    void window.eventsLauncher.state().then((next) => {
      if (mounted) setState(next);
    }).catch((error: unknown) => {
      if (mounted) setState({ ...initialState, phase: 'error', error: String(error), detail: '' });
    });
    void window.eventsLauncher.getSettings().then((saved) => {
      if (mounted) {
        setSettings(saved);
        setDraftNickname(saved.nickname);
      }
    }).catch((error: unknown) => {
      console.error('Failed to read launcher settings:', error);
    });
    void window.eventsLauncher.getSkins().then((library) => {
      if (mounted) setSkins(library);
    }).catch(() => {});
    void window.eventsLauncher.getDefaultSteve().then((steve) => {
      if (mounted) setDefaultSteve(steve);
    }).catch(() => {});
    return () => { mounted = false; unsubscribe(); unsubscribeUpdate(); };
  }, []);


  async function commitNickname(nameToSave: string) {
    if (busy || running) return;
    const trimmed = nameToSave.trim();
    if (trimmed === (settings?.nickname ?? '')) return;
    if (trimmed.length > 0 && (trimmed.length < 3 || !/^[A-Za-z0-9_]{3,16}$/.test(trimmed))) {
      return;
    }
    try {
      const saved = await window.eventsLauncher.saveSettings({
        nickname: trimmed,
        memoryMb: settings?.memoryMb ?? 4096,
        gpuPreference: settings?.gpuPreference ?? 'automatic',
      });
      setSettings(saved);
    } catch (err) {
      console.error('Failed to auto-save nickname:', err);
    }
  }

  async function openSettings() {
    setSettingsError(null);
    setSkinError(null);
    if (settings) {
      setDraftNickname(settings.nickname);
      setDraftMemoryMb(settings.memoryMb);
      setDraftGpuPreference(settings.gpuPreference);
      setDraftJvmArguments(settings.jvmArguments ?? '');
      setSettingsOpen(true);
    }
    try {
      const [saved, library, steve] = await Promise.all([
        window.eventsLauncher.getSettings(),
        window.eventsLauncher.getSkins(),
        defaultSteve ? Promise.resolve(defaultSteve) : window.eventsLauncher.getDefaultSteve().catch((error: unknown) => {
          console.error('Не удалось прочитать стандартный Steve:', error);
          return null;
        }),
      ]);
      setDefaultSteve(steve);
      setSkins(library);
      setSettings(saved);
      setDraftNickname(saved.nickname);
      setDraftMemoryMb(saved.memoryMb);
      setDraftGpuPreference(saved.gpuPreference);
      setDraftJvmArguments(saved.jvmArguments ?? '');
      setSettingsOpen(true);
    } catch (error) {
      setState((previous) => ({ ...previous, error: 'Не удалось открыть настройки: ' + String(error) }));
    }
  }

  async function manageSkin(operation: () => Promise<SkinLibrarySnapshot>) {
    if (skinBusy) return;
    setSkinBusy(true);
    setSkinError(null);
    try {
      setSkins(await operation());
    } catch (error) {
      setSkinError((error instanceof Error ? error.message : String(error))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally {
      setSkinBusy(false);
    }
  }

  async function closeAndSaveSettings() {
    if (settingsSaving) return;
    // Changes cannot be saved while the game is launching or running.
    // Closing remains possible, just as with the old X button.
    if (busy || running) {
      setSettingsOpen(false);
      return;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const saved = await window.eventsLauncher.saveSettings({
        // Keep the last valid nickname if an unfinished/invalid one was entered.
        nickname: nicknameValid ? draftNickname : (settings?.nickname ?? ''),
        memoryMb: draftMemoryMb,
        gpuPreference: draftGpuPreference,
      });
      setSettings(saved);
      setSettingsOpen(false);
    } catch (error) {
      setSettingsError(String(error));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function perform(operation: () => Promise<RuntimeState>) {
    setRequestBusy(true);
    try {
      setState(await operation());
    } catch (error) {
      setState((previous) => ({ ...previous, error: (error instanceof Error ? error.message : String(error))
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }));
    } finally {
      setRequestBusy(false);
    }
  }

  async function onMainAction() {
    if (!projectWarSelected || busy || running || updateRequired) return;
    if (!ready) {
      await perform(() => window.eventsLauncher.install());
      return;
    }
    const nickname = draftNickname.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nickname)) {
      setNicknameRequired(true);
      nicknameInput.current?.focus();
      return;
    }
    setNicknameRequired(false);
    setState((previous) => ({ ...previous, error: null }));
    await perform(() => window.eventsLauncher.launch(nickname));
  }

  async function onVerifyFiles() {
    if (!projectWarSelected || busy || running || updateRequired) return;
    await perform(async () => {
      const result = await window.eventsLauncher.install();
      if (result.phase === 'ready' && result.packConfigured) {
        return window.eventsLauncher.installPack();
      }
      return result;
    });
  }

  const activeSkin = skins.skins.find((skin) => skin.id === skins.activeId);
  const selectedSkinModel = activeSkin?.model ?? defaultSkinModel;
  let actionLabel = 'Установить игру';
  if (running) actionLabel = 'Игра запущена';
  else if (busy) actionLabel = state.phase === 'launching' ? 'Запускаем…' : 'Установка…';
  else if (ready && state.packUpdateAvailable) actionLabel = 'Обновить и играть';
  else if (ready && state.packConfigured && !state.packInstalled) actionLabel = 'Установить и играть';
  else if (ready) actionLabel = 'Запустить игру';

  return (
    <main className={'app pack-' + selected.id}>

      {['checking', 'error'].includes(launcherUpdate.phase) && !updateRequired && (
        <section className="launcher-update-banner" role="status">
          <span className={launcherUpdate.phase === 'error' ? 'selectable-error' : undefined}>{launcherUpdate.phase === 'checking' ? 'Проверяем обновления лаунчера…' : 'Не удалось проверить обновления лаунчера'}</span>
          <button type="button" disabled={launcherUpdate.phase === 'checking'} onClick={() => void window.eventsLauncher.downloadLauncherUpdate().catch(console.error)}>{launcherUpdate.phase === 'checking' ? 'Проверяем…' : 'Повторить'}</button>
        </section>
      )}
      {updateRequired && (
        <div className="required-update-overlay">
          <section className="required-update-dialog" role="dialog" aria-modal="true" aria-labelledby="required-update-title">
            <h2 id="required-update-title">{['idle', 'checking'].includes(launcherUpdate.phase) ? 'Проверяем версию лаунчера' : 'Необходимо обновить лаунчер'}</h2>
            <p role="status" aria-live="polite" className={launcherUpdate.phase === 'error' ? 'selectable-error' : undefined}>
              {['idle', 'checking'].includes(launcherUpdate.phase) && 'Подключаемся к серверу обновлений…'}
              {launcherUpdate.phase === 'available' && 'Начинаем загрузку обновления…'}
              {launcherUpdate.phase === 'downloading' && ('Скачиваем обновление · ' + launcherUpdate.percent + '%')}
              {launcherUpdate.phase === 'downloaded' && 'Обновление скачано. Перезапустите лаунчер для установки.'}
              {launcherUpdate.phase === 'error' && 'Не удалось проверить или скачать обновление. Проверьте подключение и повторите попытку.'}
            </p>
            <p>Запуск игры доступен только на актуальной версии лаунчера.</p>
            <div className="required-update-meter">{launcherUpdate.phase === 'downloading' && <progress max="100" value={launcherUpdate.percent} aria-label="Загрузка обновления" />}</div>
            <div className="required-update-actions">
            {launcherUpdate.phase === 'error' && <button className="primary-button" type="button" onClick={() => void window.eventsLauncher.downloadLauncherUpdate().catch(console.error)}>Повторить</button>}
            {launcherUpdate.phase === 'downloaded' && <button className="primary-button" type="button" disabled={busy || running} onClick={() => void window.eventsLauncher.installLauncherUpdate().catch(console.error)}>Перезапустить и обновить</button>}
            </div>
          </section>
        </div>
      )}

      <section className="main-view" aria-labelledby="event-title">
        <div className="main-copy">
          <h1 id="event-title">{selected.title}</h1>
          <p className="description">{selected.description}</p>
          <div className="actions">
            <button className="primary-button" type="button"
              disabled={!projectWarSelected || busy || running || updateRequired}
              onClick={() => void onMainAction()}>
              {busy ? <LoaderCircle size={15} className="spinner" />
                : ready && projectWarSelected
                  ? <Play size={14} fill="currentColor" />
                  : <span aria-hidden="true">↓</span>}
              <span>{projectWarSelected ? actionLabel : 'Скоро'}</span>
            </button>
            {projectWarSelected && (
              <button className="text-button" type="button"
                disabled={busy || running} onClick={() => void onVerifyFiles()}>
                <RotateCcw size={14} /> Проверить файлы
              </button>
            )}
          </div>
          {projectWarSelected && busy && !state.error && (
            <div className="game-download-progress">
              <div className="game-download-info">
                <span className="game-download-stage" title={state.detail || undefined}>
                  {getDownloadStageTitle(state.detail)}
                </span>
                {getDownloadMeta(state.downloadProgress) && (
                  <span className="game-download-meta" title={getDownloadMeta(state.downloadProgress) || undefined}>
                    {getDownloadMeta(state.downloadProgress)}
                  </span>
                )}
              </div>
              <progress max={state.downloadProgress?.total || 1}
                value={state.downloadProgress ? state.downloadProgress.downloaded : undefined}
                aria-label="Прогресс текущего этапа установки" />
            </div>
          )}
          {projectWarSelected && (state.error || (!busy && !running && statusVisible)) && (
            <div className={'status-line' + (state.error ? ' status-error' : '')}
              role="status" aria-live="polite">
              {state.error && <CircleAlert size={14} />}
              <span>{state.error ?? (state.packUpdateAvailable ? 'Доступно обновление сборки' : state.detail)}</span>
            </div>
          )}
        </div>
      </section>

      <nav className="pack-bar" aria-label="Выбор сборки">
        <div className={'player-nickname-box' + ((nicknameRequired || draftNickname.length > 0) && !/^[A-Za-z0-9_]{3,16}$/.test(draftNickname) ? ' invalid' : '')}
          title={draftNickname.length > 0 && draftNickname.length < 3 ? 'От 3 до 16 символов (A-Z, 0-9, _)' : 'Игровой ник'}>
          <User size={15} className="player-nickname-icon" aria-hidden="true" />
          <input
            ref={nicknameInput}
            aria-invalid={(nicknameRequired || draftNickname.length > 0) && !/^[A-Za-z0-9_]{3,16}$/.test(draftNickname)}
            type="text"
            className="player-nickname-input"
            placeholder="Игровой ник"
            value={draftNickname}
            disabled={busy || running}
            maxLength={16}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Игровой никнейм"
            onChange={(e) => {
              const cleaned = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
              setDraftNickname(cleaned);
              if (cleaned.length >= 3) {
                void commitNickname(cleaned);
              }
            }}
            onBlur={() => void commitNickname(draftNickname)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void commitNickname(draftNickname);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </div>
        <div className="pack-options">
          {events.map((event) => (
            <button className={'pack-option' + (event.id === selected.id ? ' selected' : '')}
              key={event.id} type="button"
              disabled={event.status === 'coming-soon'}
              aria-disabled={event.status === 'coming-soon'}
              aria-current={event.id === selected.id ? 'page' : undefined}>
              {event.title}
            </button>
          ))}
        </div>
        <button className="bar-settings-button" type="button" aria-label="Настройки" title="Настройки"
          onClick={() => void openSettings()}>
          <Settings size={18} strokeWidth={1.7} />
        </button>
      </nav>

      {settingsOpen && (
        <div className="settings-overlay" role="presentation">
          <section className="settings-dialog" role="dialog" aria-modal="true"
            aria-labelledby="settings-title">
            <div className="settings-head">
              <h2 id="settings-title">Настройки</h2>
              <button className="icon-button" type="button" aria-label="Закрыть настройки"
                disabled={settingsSaving} onClick={() => void closeAndSaveSettings()}><X size={18} /></button>
            </div>
            <div className="settings-layout">
              <div className="settings-fields">
                <div className="setting-field memory-field">
              <div className="memory-head">
                <label htmlFor="memory-allocation">Выделение ОЗУ</label>
                <strong>{formatGb(draftMemoryMb)}</strong>
              </div>
              <input id="memory-allocation" type="range"
                min={settings?.minimumMemoryMb ?? 2048}
                max={settings?.maximumMemoryMb ?? 4096}
                step={settings?.memoryStepMb ?? 512}
                value={draftMemoryMb}
                onChange={(event) => setDraftMemoryMb(Number(event.target.value))}/>
              <div className="memory-limits">
                <span>{formatGb(settings?.minimumMemoryMb ?? 2048)}</span>
                <span>{formatGb(settings?.maximumMemoryMb ?? 4096)}</span>
              </div>
            </div>
            <div className="setting-field gpu-field">
              <label htmlFor="gpu-preference">Видеокарта</label>
              <select id="gpu-preference" value={draftGpuPreference}
                onChange={(event) => setDraftGpuPreference(event.target.value as LauncherSettings['gpuPreference'])}>
                <option value="automatic">Автоматически (Windows)</option>
                <option value="discrete">Дискретная (производительность)</option>
                <option value="integrated">Встроенная (энергосбережение)</option>
              </select>
              <p className="gpu-hint">Применится при следующем запуске игры.</p>
            </div>
            <div className="setting-field">
              <button type="button" className="skin-upload-button" disabled={busy || running || requestBusy || !state.packInstalled}
                onClick={() => void perform(() => window.eventsLauncher.restoreSettings('configs'))}>Обновить конфиги</button>
              <button type="button" className="skin-upload-button" disabled={busy || running || requestBusy || !state.packInstalled}
                onClick={() => void perform(() => window.eventsLauncher.restoreSettings('options'))}>Обновить options.txt</button>
              <p className="gpu-hint">Внимание: могут сброситься назначения клавиш и ваши личные настройки.</p>
            </div>
            <div className="setting-field jvm-field">
              <label htmlFor="jvm-arguments">Аргументы JVM</label>
              <input id="jvm-arguments" type="text" spellCheck={false}
                autoComplete="off" autoCorrect="off" autoCapitalize="off"
                placeholder="-XX:+UseG1GC"
                value={draftJvmArguments}
                onChange={(event) => setDraftJvmArguments(event.target.value)}/>
              <p className="jvm-hint">Дополнительные флаги виртуальной машины Java.</p>
            </div>
              </div>
              <aside className="settings-skin-column">
                <section className="skin-settings" aria-label="Управление скинами">
              <div className="skin-section-heading">
                <label>Скин</label>
              </div>
              <div className="skin-preview-panel">
                <SkinPreview3D skinUrl={activeSkin?.preview ?? defaultSteve ?? undefined}
                  model={selectedSkinModel} />
              </div>
              <div className="skin-action-buttons">
                <button className="skin-upload-button" type="button" disabled={skinBusy}
                  onClick={() => void manageSkin(async () => {
                    const next = await window.eventsLauncher.addSkin();
                    // Preserve the selected arm model when replacing/uploading a PNG.
                    if (next.activeId && next.activeId !== skins.activeId && selectedSkinModel === 'slim') {
                      return window.eventsLauncher.changeSkinModel(next.activeId, 'slim');
                    }
                    return next;
                  })}>
                  <Upload size={16} aria-hidden="true" />
                  {activeSkin ? 'Заменить' : 'Загрузить'}
                </button>
                {activeSkin && (
                  <button className="skin-delete-current" type="button" disabled={skinBusy}
                    aria-label="Удалить выбранный скин" title="Удалить выбранный скин"
                    onClick={() => void manageSkin(() => window.eventsLauncher.removeSkin(activeSkin.id))}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="skin-model-row">
                <span className="skin-model-label">Модель рук</span>
                <div className="skin-model-switch" role="group" aria-label="Модель рук">
                  <button type="button" className={selectedSkinModel === 'default' ? 'active' : ''}
                    aria-pressed={selectedSkinModel === 'default'}
                    aria-label="Classic — обычные руки" disabled={skinBusy}
                    onClick={() => activeSkin
                      ? void manageSkin(() => window.eventsLauncher.changeSkinModel(activeSkin.id, 'default'))
                      : setDefaultSkinModel('default')}>
                    Обычные
                  </button>
                  <button type="button" className={selectedSkinModel === 'slim' ? 'active' : ''}
                    aria-pressed={selectedSkinModel === 'slim'}
                    aria-label="Slim — тонкие руки" disabled={skinBusy}
                    onClick={() => activeSkin
                      ? void manageSkin(() => window.eventsLauncher.changeSkinModel(activeSkin.id, 'slim'))
                      : setDefaultSkinModel('slim')}>
                    Тонкие
                  </button>
                </div>
              </div>
                </section>
              </aside>
            </div>
            {skinError && <div className="settings-error" role="alert">{skinError}</div>}
            {settingsError && <div role="alert" className="settings-error">{settingsError}</div>}
          </section>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);

