import { MobileQuickCommandSection } from './MobileQuickCommandSection';
import { MobileSkillSection } from './MobileSkillSection';

/**
 * 快捷命令与技能合并页。
 *
 * 两者都是用户自建资源的 CRUD 管理，合并减少分区入口。
 * 用分段标题区分，各自内部逻辑保持独立（MobileSheet 编辑浮层互不干扰）。
 */
export function MobileCommandsSkillsSection() {
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h2 className="mb-2 px-1 text-xs font-medium text-zinc-500">
          快捷命令
        </h2>
        <MobileQuickCommandSection />
      </section>
      <section>
        <h2 className="mb-2 px-1 text-xs font-medium text-zinc-500">
          技能（Skills）
        </h2>
        <MobileSkillSection />
      </section>
    </div>
  );
}
