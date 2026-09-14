import { useEffect, useState } from 'react';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';

/**
 * 内置的命令审批系统提示词，取自后端模板 `templates/approval/审批.hbs`。
 *
 * 前端不再自带副本（以前 TS 里那份与模板逐字节相同，两边会各自漂移）：
 * 设置项留空时用它的内容做展示默认值，用户编辑后与它比较——与内置文本完全
 * 相同则存回空串，即"未自定义"。
 *
 * 取不到时返回空串，输入框回落到 placeholder，不阻塞用户自定义。
 */
export function useDefaultApprovalPrompt(): string {
  const [text, setText] = useState('');
  useEffect(() => {
    let cancelled = false;
    tauri
      .agentDefaultApprovalPrompt()
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((e) => {
        console.warn('读取内置审批提示词失败：', getErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return text;
}
