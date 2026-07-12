import Select from '@/components/ui/Select';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

const COMPRESSION_LEVELS = [
  { value: 0, label: '0 - 最快，文件最大' },
  { value: 1, label: '1 - 偏速度' },
  { value: 3, label: '3 - 快速压缩' },
  { value: 6, label: '6 - 平衡（推荐）' },
  { value: 9, label: '9 - 最小文件，最慢' },
];

export function TransferSection() {
  const { settings, update } = useSettingsActions();
  const currentLevel = settings.folderUploadCompressionLevel ?? 6;

  return (
    <Card id="settings-transfer" title="SFTP 上传" description="调整文件管理器中的上传行为">
      <SettingItem
        id="folder-upload-compression-level"
        label="文件夹压缩等级"
        description="保存后对新的文件夹上传生效；等级越高压缩包越小，但打包更慢。"
        sectionId="settings-transfer"
        keywords={['zip', 'compression', '压缩', '上传', '文件夹', 'folder upload', '文件传输', 'SFTP']}
      >
        <Select
          value={String(currentLevel)}
          onChange={(v) => update({ folderUploadCompressionLevel: Number(v) })}
          options={COMPRESSION_LEVELS.map((l) => ({ value: String(l.value), label: l.label }))}
          className="w-52"
        />
      </SettingItem>
    </Card>
  );
}
