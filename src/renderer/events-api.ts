export type RuntimeState = {
  downloadProgress?: { downloaded: number; total: number } | null;
  phase: 'idle' | 'checking-pack' | 'installing' | 'installing-pack' | 'ready' | 'launching' | 'running' | 'error';
  detail: string;
  error: string | null;
  packConfigured: boolean;
  packInstalled: boolean;
  packUpdateAvailable: boolean;
};

export type LauncherSettings = {
  nickname: string;
  memoryMb: number;
  gpuPreference: 'automatic' | 'integrated' | 'discrete';
  jvmArguments: string;
  minimumMemoryMb: number;
  maximumMemoryMb: number;
  totalMemoryMb: number;
  memoryStepMb: number;
};

export type LauncherUpdate = {
  phase: 'idle' | 'unavailable' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';
  version: string | null;
  percent: number;
  message?: string;
};

export type PlayerSkin = {
  id: string;
  name: string;
  model: 'default' | 'slim';
  preview: string;
};

export type SkinLibrarySnapshot = {
  activeId: string | null;
  skins: PlayerSkin[];
};

export type EventsLauncherBridge = {
  state(): Promise<RuntimeState>;
  checkPack(): Promise<RuntimeState>;
  launcherUpdateState(): Promise<LauncherUpdate>;
  downloadLauncherUpdate(): Promise<LauncherUpdate>;
  installLauncherUpdate(): Promise<void>;
  onLauncherUpdate(listener: (state: LauncherUpdate) => void): () => void;
  getSettings(): Promise<LauncherSettings>;
  getSkins(): Promise<SkinLibrarySnapshot>;
  getDefaultSteve(): Promise<string | null>;
  addSkin(): Promise<SkinLibrarySnapshot>;
  selectSkin(id: string | null): Promise<SkinLibrarySnapshot>;
  changeSkinModel(id: string, model: 'default' | 'slim'): Promise<SkinLibrarySnapshot>;
  removeSkin(id: string): Promise<SkinLibrarySnapshot>;
  saveSettings(settings: Pick<LauncherSettings, 'nickname' | 'memoryMb' | 'gpuPreference'> & { jvmArguments?: string }): Promise<LauncherSettings>;
  install(): Promise<RuntimeState>;
  installPack(): Promise<RuntimeState>;
  launch(nickname: string): Promise<RuntimeState>;
  onProgress(listener: (state: RuntimeState) => void): () => void;
};

declare global {
  interface Window {
    eventsLauncher: EventsLauncherBridge;
  }
}
