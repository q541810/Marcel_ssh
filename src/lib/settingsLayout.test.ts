import { describe, expect, it } from 'vitest';
import { resolveSettingsLayout } from './settingsLayout';

describe('settingsLayout', () => {
  it('uses compact layout for narrow settings view', () => {
    expect(resolveSettingsLayout(800)).toMatchObject({
      mode: 'compact',
      sidebarWidth: 220,
      sectionColumns: 1,
      itemLayout: 'stacked',
    });
  });

  it('uses normal single-column layout for default windows', () => {
    expect(resolveSettingsLayout(1200)).toMatchObject({
      mode: 'normal',
      sidebarWidth: 256,
      contentMaxWidth: 960,
      sectionColumns: 1,
      itemLayout: 'inline',
    });
  });

  it('uses wide two-column layout on large screens', () => {
    expect(resolveSettingsLayout(1900)).toMatchObject({
      mode: 'wide',
      sidebarWidth: 304,
      contentMaxWidth: 1280,
      sectionColumns: 2,
      itemLayout: 'inline',
      labelWidth: 192,
    });
  });
});
