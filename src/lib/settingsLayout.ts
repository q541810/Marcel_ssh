export type SettingsLayoutMode = 'compact' | 'normal' | 'wide' | 'extraWide';
export type SettingsItemLayout = 'stacked' | 'inline';

export interface SettingsLayout {
  mode: SettingsLayoutMode;
  sidebarWidth: number;
  contentMaxWidth: number;
  contentPaddingX: number;
  sectionColumns: 1 | 2;
  itemLayout: SettingsItemLayout;
  /** 设置项右侧控件列的固定宽度；说明文字吃掉剩余宽度（stacked 时不用）。 */
  controlWidth: number;
}

export function resolveSettingsLayout(width: number): SettingsLayout {
  if (width < 900) {
    return {
      mode: 'compact',
      sidebarWidth: 220,
      contentMaxWidth: 760,
      contentPaddingX: 20,
      sectionColumns: 1,
      itemLayout: 'stacked',
      controlWidth: 0,
    };
  }

  if (width < 1500) {
    return {
      mode: 'normal',
      sidebarWidth: 256,
      contentMaxWidth: 960,
      contentPaddingX: 32,
      sectionColumns: 1,
      itemLayout: 'inline',
      controlWidth: 320,
    };
  }

  if (width < 1920) {
    return {
      mode: 'wide',
      sidebarWidth: 304,
      contentMaxWidth: 1280,
      contentPaddingX: 40,
      sectionColumns: 2,
      itemLayout: 'inline',
      controlWidth: 280,
    };
  }

  return {
    mode: 'extraWide',
    sidebarWidth: 320,
    contentMaxWidth: 1600,
    contentPaddingX: 48,
    sectionColumns: 2,
    itemLayout: 'inline',
    controlWidth: 320,
  };
}
