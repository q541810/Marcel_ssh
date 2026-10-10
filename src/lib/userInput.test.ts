import { describe, expect, it } from 'vitest';
import type { UserInputMetadata } from './types';
import { composeUserInput, validateUserInput } from './userInput';

const input: UserInputMetadata = {
  version: 1,
  text: '请检查配置',
  textAttachments: [
    { id: 'f1', name: '配置.conf', content: '  第一行\r\n第二行\n\n', size: 32 },
    { id: 'f2', name: 'empty.txt', content: '', size: 0 },
  ],
};

describe('user input metadata', () => {
  it('composes all files in order without trimming their contents', () => {
    const content = composeUserInput(input);
    expect(content).toBe('请检查配置\n\n===== 文件名: 配置.conf =====\n  第一行\r\n第二行\n\n'
      + '\n\n===== 文件名: empty.txt =====\n');
    expect(validateUserInput(content, input)).toEqual(input);
  });

  it('accepts attachment-only input, including an empty file', () => {
    const filesOnly: UserInputMetadata = { ...input, text: '' };
    expect(composeUserInput(filesOnly)).not.toBe('');
    expect(validateUserInput(composeUserInput(filesOnly), filesOnly)).toEqual(filesOnly);
  });

  it('preserves user text and file contents that resemble attachment delimiters', () => {
    const nested: UserInputMetadata = {
      version: 1,
      text: '  ===== 文件名: 用户自己写的 =====\n  ',
      textAttachments: [{ id: 'f', name: 'log.txt', content: '\n===== 文件名: nested =====\n🧪\n' }],
    };
    expect(validateUserInput(composeUserInput(nested), nested)).toEqual(nested);
    expect(validateUserInput(composeUserInput(nested), undefined)).toBeUndefined();
  });

  it.each([
    undefined, null, '', [], {}, { ...input, version: 2 },
    { ...input, text: null }, { ...input, textAttachments: null },
    { ...input, textAttachments: [null] },
    { ...input, textAttachments: [{ ...input.textAttachments[0], id: '' }] },
    { ...input, textAttachments: [input.textAttachments[0], input.textAttachments[0]] },
    { ...input, textAttachments: [{ ...input.textAttachments[0], name: '' }] },
    { ...input, textAttachments: [{ ...input.textAttachments[0], content: 42 }] },
    { ...input, textAttachments: [{ ...input.textAttachments[0], size: -1 }] },
    { ...input, textAttachments: [{ ...input.textAttachments[0], size: Infinity }] },
    { ...input, textAttachments: [{ ...input.textAttachments[0], size: 1.5 }] },
  ])('rejects absent or invalid structures without guessing from content: %j', (value) => {
    expect(validateUserInput(composeUserInput(input), value)).toBeUndefined();
  });

  it('rejects mismatched content so metadata cannot hide any original text', () => {
    expect(validateUserInput(composeUserInput(input) + 'extra', input)).toBeUndefined();
    expect(validateUserInput(composeUserInput(input).trim(), input)).toBeUndefined();
  });

  it('allows a metadata-bearing plain message without manufacturing attachments', () => {
    const plain: UserInputMetadata = { version: 1, text: '保留原文\n', textAttachments: [] };
    expect(composeUserInput(plain)).toBe(plain.text);
    expect(validateUserInput(plain.text, plain)).toEqual(plain);
  });
});
