import { MobileAgentToolsSection } from './MobileAgentToolsSection';
import { MobileMcpServerSection } from './MobileMcpServerSection';
import { MobileSkillSection } from './MobileSkillSection';

/**
 * 「工具与扩展」页（手机）：给 Agent 加能力的东西——内置工具（联网搜索 / 网页获取等）、
 * 技能、MCP 服务。桌面端同名页是 内置工具 / MCP 服务 / 插件（插件手机端没有）。
 * 各段内部逻辑保持独立，用分段标题区分。
 */
export function MobileToolsPage() {
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h2 className="mb-2 px-1 text-meta font-medium text-fg-tertiary">内置工具</h2>
        <MobileAgentToolsSection />
      </section>
      <section>
        <h2 className="mb-2 px-1 text-meta font-medium text-fg-tertiary">技能（Skills）</h2>
        <MobileSkillSection />
      </section>
      <section>
        <h2 className="mb-2 px-1 text-meta font-medium text-fg-tertiary">MCP 服务</h2>
        <MobileMcpServerSection />
      </section>
    </div>
  );
}
