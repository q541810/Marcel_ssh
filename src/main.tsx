import React from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './components/layout/ErrorBoundary';
import { collectPlatformHints, getAppPlatform } from './platform';
import { initUiThemeEarly } from './lib/uiTheme';
import { installNativeContextMenuGuard } from './lib/nativeContextMenu';
import './styles/globals.css';

async function bootstrap() {
  const hints = collectPlatformHints();
  const platform = getAppPlatform(hints);
  // Visible in DevTools — if you still see desktop, force did not apply
  console.info(`[marcel] platform=${platform}`, hints);

  document.documentElement.dataset.marcelPlatform = platform;

  // 桌面端屏蔽浏览器自带的右键菜单（刷新 / 检查…）；输入框与选中文字的原生菜单保留。
  // 手机端长按就是 contextmenu（也是选词入口），不动；开发模式留着「检查」。
  if (platform !== 'mobile' && !import.meta.env.DEV) installNativeContextMenuGuard();

  // 设置异步加载之前先应用上次的主题（localStorage 缓存），避免浅色用户先看到一帧深色。
  initUiThemeEarly();

  // Window starts visible:false. Desktop App calls appReady; mobile must too.
  // Fire ASAP so a late React mount never leaves an invisible process.
  if (platform === 'mobile') {
    void import('@/lib/tauri')
      .then((m) => m.appReady())
      .catch(() => {});
  }

  const RootApp =
    platform === 'mobile'
      ? (await import('./mobile/App')).default
      : (await import('./App')).default;

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <RootApp />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
