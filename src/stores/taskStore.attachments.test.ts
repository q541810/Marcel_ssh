import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LlmRegistry, UserInputMetadata } from '@/lib/types';
import { emptyRegistry } from '@/lib/llmRegistry';
import { composeUserInput } from '@/lib/userInput';
import { useConversationStore } from '@/stores/conversationStore';
import { useDebugStore } from '@/stores/debugStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';

const {
  agentStartTask,
  agentSaveMessageImages,
  agentSaveUserMessage,
  agentDeleteMessageImage,
  attachStreamListener,
  attachPlanListener,
  cleanupTaskListeners,
} = vi.hoisted(() => ({
  agentStartTask: vi.fn<typeof import('@/lib/tauri').agentStartTask>(),
  agentSaveMessageImages: vi.fn<typeof import('@/lib/tauri').agentSaveMessageImages>(),
  agentSaveUserMessage: vi.fn<typeof import('@/lib/tauri').agentSaveUserMessage>(),
  agentDeleteMessageImage: vi.fn<typeof import('@/lib/tauri').agentDeleteMessageImage>(),
  attachStreamListener: vi.fn(),
  attachPlanListener: vi.fn(),
  cleanupTaskListeners: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentStartTask,
  agentSaveMessageImages,
  agentSaveUserMessage,
  agentDeleteMessageImage,
}));
vi.mock('@/stores/agentStreamManager', () => ({
  attachStreamListener,
  attachPlanListener,
  cleanupTaskListeners,
}));

const conversationId = 'attachment-conversation';
const sessionId = 'attachment-session';
const connectionId = 'attachment-connection';
const imageDataUrl = 'data:image/png;base64,aW1hZ2U=';
const savedImagePaths = [`${conversationId}/saved-image.png`];
const initialSettings = useSettingsStore.getState().settings;
const previousMessages: AgentMessage[] = [
  { id: 'old-user', role: 'user', content: '保留旧消息\n', timestamp: '2026-01-01T00:00:00Z' },
  { id: 'old-answer', role: 'assistant', content: '之前的回复', timestamp: '2026-01-01T00:00:01Z' },
];

function modelRegistry(): LlmRegistry {
  return {
    ...emptyRegistry(),
    channels: [{ id: 'channel', name: '测试渠道', baseUrl: 'https://example.invalid/v1', enabled: true }],
    models: [
      { id: 'vision-model', channelId: 'channel', modelName: 'vision', temperature: 0.1, vision: true },
      { id: 'text-model', channelId: 'channel', modelName: 'text', temperature: 0.1, vision: false },
    ],
    lastUsedModelId: 'vision-model',
  };
}

function makeUserInput(text = '请检查这两个文件'): UserInputMetadata {
  return {
    version: 1,
    text,
    textAttachments: [
      { id: 'file-1', name: 'first.txt', content: 'alpha\n\n', size: 7 },
      { id: 'file-2', name: 'second.txt', content: '\t末行\r\n\r\n' },
    ],
  };
}

function messages(): AgentMessage[] {
  return useConversationStore.getState().messages[conversationId];
}

function seedPreviousMessages(): void {
  useConversationStore.setState({ messages: { [conversationId]: [...previousMessages] } });
}

describe('taskStore 附件发送', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    agentStartTask.mockResolvedValue('backend-task');
    agentSaveMessageImages.mockResolvedValue(savedImagePaths);
    agentSaveUserMessage.mockResolvedValue(undefined);
    agentDeleteMessageImage.mockResolvedValue(undefined);
    attachStreamListener.mockResolvedValue(undefined);
    attachPlanListener.mockResolvedValue(undefined);
    useTaskStore.setState({
      tasks: {},
      activeTaskId: null,
      mode: 'agent',
      plans: {},
      plansDirty: false,
      compacting: {},
      unreadCompletedConversations: [],
      usageByConversation: {},
    });
    useConversationStore.setState({
      conversations: {
        [conversationId]: {
          id: conversationId,
          connectionId,
          title: '附件会话',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          modelId: 'vision-model',
        },
      },
      messages: { [conversationId]: [] },
      activeConversationId: conversationId,
    });
    useSettingsStore.setState({
      settings: { ...initialSettings, llmRegistry: modelRegistry() },
      loaded: false,
    });
    useDebugStore.setState({ debug67Mode: false });
  });

  it.each([
    { label: '只有文件且没有历史', text: '', hasHistory: false },
    { label: '文字和多个文件且已有历史', text: '请检查这两个文件', hasHistory: true },
  ])('$label：完整内容只拼一次，文件末尾换行不丢失', async ({ text, hasHistory }) => {
    if (hasHistory) seedPreviousMessages();
    const userInput = makeUserInput(text);
    const expected = `${text}\n\n===== 文件名: first.txt =====\nalpha\n\n\n\n===== 文件名: second.txt =====\n\t末行\r\n\r\n`;

    const taskId = await useTaskStore.getState().startTask(
      sessionId, text, connectionId, undefined, undefined, { conversationId, userInput },
    );

    expect(agentStartTask).toHaveBeenCalledTimes(1);
    const [, prompt, , targetConversation, snapshot, sentTaskId, , , sentMetadata] = agentStartTask.mock.calls[0];
    expect(prompt).toBe(expected);
    expect(prompt.endsWith('\r\n\r\n')).toBe(true);
    for (const attachment of userInput.textAttachments) {
      expect(prompt.split(`===== 文件名: ${attachment.name} =====`)).toHaveLength(2);
    }
    expect(snapshot.entries).toEqual([
      ...(hasHistory ? previousMessages.map(({ role, content }) => ({ kind: 'transient', message: { role, content } })) : []),
      { kind: 'transient', message: { role: 'user', content: expected } },
      { kind: 'transient', message: { role: 'assistant', content: '', isLoading: true } },
    ]);
    expect(targetConversation).toBe(conversationId);
    expect(sentTaskId).toBe(taskId);
    expect(sentMetadata).toEqual(userInput);
    expect(messages().slice(-2)[0]).toMatchObject({ role: 'user', content: expected, userInput });
    expect(useTaskStore.getState().tasks[taskId].prompt).toBe(expected);
    expect(agentSaveMessageImages).not.toHaveBeenCalled();
    expect(agentSaveUserMessage).not.toHaveBeenCalled();
  });

  it('没有元数据的旧文本保持原样，不把文件分隔符猜成附件', async () => {
    seedPreviousMessages();
    const prompt = '\n\n===== 文件名: old.txt =====\n这是用户手写的正文\n\n';

    await useTaskStore.getState().startTask(
      sessionId, prompt, connectionId, undefined, undefined, { conversationId },
    );

    expect(agentStartTask.mock.calls[0][1]).toBe(prompt);
    expect(agentStartTask.mock.calls[0][4].entries.slice(-2)[0]).toEqual({
      kind: 'transient', message: { role: 'user', content: prompt },
    });
    expect(agentStartTask.mock.calls[0][8]).toBeUndefined();
    expect(messages().slice(0, previousMessages.length)).toEqual(previousMessages);
    expect(messages().slice(-2)[0]).toMatchObject({ role: 'user', content: prompt });
    expect(messages().slice(-2)[0]?.userInput).toBeUndefined();
  });

  it('会话模型支持图片时保留图片，即使全局默认模型不支持', async () => {
    const registry = modelRegistry();
    registry.lastUsedModelId = 'text-model';
    useSettingsStore.setState({ settings: { ...initialSettings, llmRegistry: registry } });
    const userInput = makeUserInput();

    await useTaskStore.getState().startTask(
      sessionId, userInput.text, connectionId, [imageDataUrl], undefined, { conversationId, userInput },
    );

    const userMessage = messages().find((message) => message.role === 'user')!;
    expect(agentSaveMessageImages).toHaveBeenCalledTimes(1);
    expect(agentSaveMessageImages).toHaveBeenCalledWith(conversationId, userMessage.id, [imageDataUrl]);
    expect(userMessage.imagePaths).toEqual(savedImagePaths);
    expect(agentStartTask.mock.calls[0][4]).toEqual({ entries: [
      { kind: 'transient', message: { role: 'user', content: composeUserInput(userInput), imagePaths: savedImagePaths } },
      { kind: 'transient', message: { role: 'assistant', content: '', isLoading: true } },
    ] });
    expect(agentStartTask.mock.calls[0][6]).toBe('vision-model');
  });

  it('任务启动失败补存完整正文、图片和元数据，并返回会话与失败阶段', async () => {
    agentStartTask.mockRejectedValue({ kind: 'Other', message: '后端启动失败' });
    const userInput = makeUserInput();
    const expected = composeUserInput(userInput);

    await expect(useTaskStore.getState().startTask(
      sessionId, userInput.text, connectionId, [imageDataUrl], undefined, { conversationId, userInput },
    )).rejects.toMatchObject({ message: '后端启动失败', stage: 'start_task', conversationId });

    const userMessage = messages().find((message) => message.role === 'user')!;
    expect(userMessage).toMatchObject({ content: expected, userInput, imagePaths: savedImagePaths });
    expect(agentSaveUserMessage).toHaveBeenCalledTimes(1);
    expect(agentSaveUserMessage).toHaveBeenCalledWith(
      conversationId, expected, userMessage.timestamp, savedImagePaths, userInput,
    );
    expect(messages().map((message) => message.role)).toEqual(['user', 'system']);
    expect(messages().slice(-1)[0]?.content).toBe('启动任务失败：后端启动失败');
    expect(cleanupTaskListeners).toHaveBeenCalledWith(agentStartTask.mock.calls[0][5]);
    expect(useTaskStore.getState().tasks).toEqual({});
    expect(useTaskStore.getState().activeTaskId).toBeNull();
  });

  it('图片保存失败不追加用户消息，旧历史保持原样且错误可读', async () => {
    seedPreviousMessages();
    agentSaveMessageImages.mockRejectedValue({ kind: 'Io', message: '磁盘写入失败' });
    const userInput = makeUserInput();

    await expect(useTaskStore.getState().startTask(
      sessionId, userInput.text, connectionId, [imageDataUrl], undefined, { conversationId, userInput },
    )).rejects.toMatchObject({ message: '磁盘写入失败', stage: 'save_images', conversationId });

    expect(messages().slice(0, previousMessages.length)).toEqual(previousMessages);
    expect(messages()).toHaveLength(previousMessages.length + 1);
    expect(messages().slice(-1)[0]).toMatchObject({ role: 'system', content: '保存图片失败：磁盘写入失败' });
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(agentSaveUserMessage).not.toHaveBeenCalled();
    expect(attachStreamListener).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual({});
  });

  it('会话模型不支持图片时明确拒绝，不因全局模型支持而静默丢图或启动', async () => {
    seedPreviousMessages();
    const conversation = useConversationStore.getState().conversations[conversationId];
    useConversationStore.setState({
      conversations: { [conversationId]: { ...conversation, modelId: 'text-model' } },
    });
    const userInput = makeUserInput();

    await expect(useTaskStore.getState().startTask(
      sessionId, userInput.text, connectionId, [imageDataUrl], undefined, { conversationId, userInput },
    )).rejects.toMatchObject({ message: '当前模型不支持图片，请更换模型或移除图片后发送', conversationId });

    expect(messages()).toEqual(previousMessages);
    expect(agentSaveMessageImages).not.toHaveBeenCalled();
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(agentSaveUserMessage).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual({});
  });

  it('超过五张图片时拒绝整次发送，不截断用户选中的图片', async () => {
    seedPreviousMessages();

    await expect(useTaskStore.getState().startTask(
      sessionId, '检查全部图片', connectionId, Array.from({ length: 6 }, () => imageDataUrl),
      undefined, { conversationId },
    )).rejects.toThrow('最多可发送 5 张图片，请移除多余图片');

    expect(messages()).toEqual(previousMessages);
    expect(agentSaveMessageImages).not.toHaveBeenCalled();
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(agentSaveUserMessage).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual({});
  });

  it('附件元数据无效时保持旧状态并给出可读错误', async () => {
    seedPreviousMessages();
    const userInput = makeUserInput();
    userInput.textAttachments[1].id = userInput.textAttachments[0].id;

    await expect(useTaskStore.getState().startTask(
      sessionId, userInput.text, connectionId, undefined, undefined, { conversationId, userInput },
    )).rejects.toThrow('附件内容无效，请检查后重新发送');

    expect(messages()).toEqual(previousMessages);
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(agentSaveUserMessage).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual({});
  });
});
