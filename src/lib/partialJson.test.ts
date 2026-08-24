import { describe, expect, it } from 'vitest';
import { extractPartialStringField } from './partialJson';

describe('extractPartialStringField', () => {
  it('完整 JSON 提取完整值', () => {
    const buf = JSON.stringify({ title: '图表', html: '<div>hello</div>' });
    expect(extractPartialStringField(buf, 'html')).toBe('<div>hello</div>');
    expect(extractPartialStringField(buf, 'title')).toBe('图表');
  });

  it('未闭合的字符串返回已生成前缀', () => {
    const buf = '{"title":"仪表盘","html":"<html><body><h1>CPU';
    expect(extractPartialStringField(buf, 'html')).toBe('<html><body><h1>CPU');
  });

  it('目标字段还没出现返回 null', () => {
    expect(extractPartialStringField('{"title":"仪表', 'html')).toBeNull();
    expect(extractPartialStringField('{"tit', 'html')).toBeNull();
    expect(extractPartialStringField('', 'html')).toBeNull();
    expect(extractPartialStringField('{', 'html')).toBeNull();
  });

  it('值刚开始（只有开头引号）返回空串', () => {
    expect(extractPartialStringField('{"html":"', 'html')).toBe('');
  });

  it('解码转义序列', () => {
    const buf = '{"html":"<p class=\\"big\\">a\\nb\\tc\\\\d';
    expect(extractPartialStringField(buf, 'html')).toBe('<p class="big">a\nb\tc\\d');
  });

  it('尾部悬挂反斜杠被丢弃而不是报错', () => {
    expect(extractPartialStringField('{"html":"abc\\', 'html')).toBe('abc');
  });

  it('尾部不完整 \\uXXXX 被丢弃', () => {
    expect(extractPartialStringField('{"html":"abc\\u25', 'html')).toBe('abc');
  });

  it('完整 \\uXXXX 正确解码', () => {
    expect(extractPartialStringField('{"html":"\\u4f60\\u597d', 'html')).toBe('你好');
  });

  it('目标字段在其他字段之后（前面字段完整时可提取）', () => {
    const buf = '{"card_id":"sim-1","title":"模拟器","html":"<canvas id=\\"c\\">';
    expect(extractPartialStringField(buf, 'html')).toBe('<canvas id="c">');
  });

  it('不被其他字符串值里的假 key 干扰', () => {
    const buf = '{"title":"讲解 \\"html\\": 字段的用法","html":"real';
    expect(extractPartialStringField(buf, 'html')).toBe('real');
  });

  it('跳过非字符串值（数字/布尔/对象/数组）', () => {
    const buf = '{"count":42,"ok":true,"cfg":{"a":[1,2]},"html":"x';
    expect(extractPartialStringField(buf, 'html')).toBe('x');
  });

  it('目标字段不是字符串返回 null', () => {
    expect(extractPartialStringField('{"html":123}', 'html')).toBeNull();
  });

  it('前面字段值被截断时返回 null（等待更多数据）', () => {
    expect(extractPartialStringField('{"cfg":{"a":1', 'html')).toBeNull();
    expect(extractPartialStringField('{"n":123', 'html')).toBeNull();
  });

  it('带空白的 JSON', () => {
    const buf = '{\n  "title" : "t" ,\n  "html" : "<div>';
    expect(extractPartialStringField(buf, 'html')).toBe('<div>');
  });

  it('闭合后的完整字段（后面还有其他字段在流入）', () => {
    const buf = '{"html":"<p>done</p>","title":"部分标';
    expect(extractPartialStringField(buf, 'html')).toBe('<p>done</p>');
    expect(extractPartialStringField(buf, 'title')).toBe('部分标');
  });
});
