export type SettingsLayoutMode = 'compact' | 'normal' | 'wide';
export type SettingsItemLayout = 'stacked' | 'inline';

export interface SettingsLayout {
  mode: SettingsLayoutMode;
  sidebarWidth: number;
  contentMaxWidth: number;
  contentPaddingX: number;
  sectionColumns: 1 | 2;
  itemLayout: SettingsItemLayout;
  labelWidth: number;
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
      labelWidth: 0,
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
      labelWidth: 160,
    };
  }

  return {
    mode: 'wide',
    sidebarWidth: 304,
    contentMaxWidth: 1280,
    contentPaddingX: 40,
    sectionColumns: 2,
    itemLayout: 'inline',
    labelWidth: 192,
  };
}
