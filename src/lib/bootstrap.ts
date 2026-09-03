import * as tauri from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSkillStore } from '@/stores/skillStore';

/**
 * 聚合启动 Hydration：通过一次 IPC 获取首屏所需的全部配置与数据快照，
 * 消除多重 IPC 往返的瀑布流与串行等待。
 */
export async function hydrateBootstrapData(): Promise<void> {
  try {
    const data = await tauri.getBootstrapData();

    // 1. Hydrate Settings
    useSettingsStore.getState().hydrateFromBootstrap({
      settings: data.settings,
      hasApiKey: data.hasApiKey,
      hasWebSearchApiKey: data.hasWebSearchApiKey,
      channelKeyStatus: data.channelKeyStatus,
      warning: data.settingsWarning,
    });

    // 2. Hydrate Connections
    useConnectionStore.setState({
      connections: data.connections,
      loading: false,
      error: null,
    });

    // 3. Hydrate Skills
    useSkillStore.setState({
      skills: data.skills,
      loading: false,
      error: null,
    });
  } catch (err) {
    console.warn('[Bootstrap] Snapshot hydration failed, falling back to standalone fetches:', err);
    // 优雅降级：如果聚合接口失败（如单元测试/浏览器 Mock 场景），降级执行各 store 原有的独立加载
    await Promise.allSettled([
      useSettingsStore.getState().load(),
      useConnectionStore.getState().fetchConnections(),
      useSkillStore.getState().fetchSkills(),
    ]);
  }
}
