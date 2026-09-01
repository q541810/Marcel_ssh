"""客户端版本号解析与比较（版本闸门用）。

背景：v1.2.1 对模型渠道配置做了一次大改（结构不兼容旧版）。当账户内已有
>= 阈值版本的设备写入过数据时，服务端必须拒绝低于阈值的旧客户端同步，
否则旧客户端反序列化会丢未知字段，再被三方合并当成"本地修改"推回云端，
把新格式配置啃坏。

版本号格式：点分隔的纯数字段（如 "1.2.1" / "1.10.0"）。
比较必须按数值逐段比较——字典序会得出 "1.10.0" < "1.2.0" 的错误结论。
任何一段不是纯数字即视为非法（返回 None），调用方自行决定 fail-open / fail-closed。
"""

from __future__ import annotations


def parse_version(value: str) -> tuple[int, ...] | None:
    """解析点分隔数字版本号为可比较元组；非法返回 None。

    >>> parse_version("1.2.1")
    (1, 2, 1)
    >>> parse_version("1.10.0")
    (1, 10, 0)
    >>> parse_version("abc") is None
    True
    >>> parse_version("1.x") is None
    True
    >>> parse_version("") is None
    True
    """
    if not value:
        return None
    parts: list[int] = []
    for seg in value.strip().split("."):
        if not seg.isdigit():
            return None
        parts.append(int(seg))
    return tuple(parts)


def max_version(versions: list[str]) -> str | None:
    """返回列表中数值最大的版本号；全为非法/空列表返回 None。

    >>> max_version(["1.2.0", "1.10.0", "1.9.9"])
    '1.10.0'
    >>> max_version([]) is None
    True
    >>> max_version(["junk"]) is None
    True
    """
    best: tuple[int, ...] | None = None
    best_str: str | None = None
    for v in versions:
        parsed = parse_version(v)
        if parsed is None:
            continue
        if best is None or parsed > best:
            best = parsed
            best_str = v
    return best_str
