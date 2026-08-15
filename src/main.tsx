import React from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './components/layout/ErrorBoundary';
import { collectPlatformHints, getAppPlatform } from './platform';
import { applyAppearance } from './lib/appearance';
import './styles/globals.css';

async function bootstrap() {
  const hints = collectPlatformHints();
  const platform = getAppPlatform(hints);
  // Visible in DevTools — if you still see desktop, force did not apply
  console.info(`[marcel] platform=${platform}`, hints);

  document.documentElement.dataset.marcelPlatform = platform;

  // 桌面端：默认浅色 + 亚克力，先于首次渲染应用，避免暗色闪屏
  // 手机端：保持原深色外观（不套桌面浅色主题/亚克力），仅保证代码高亮为深色
  applyAppearance(
    platform === 'mobile'
      ? { theme: 'dark', acrylic: false }
      : { theme: 'light', acrylic: true },
  );

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
