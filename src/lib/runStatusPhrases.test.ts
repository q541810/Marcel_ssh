import { describe, expect, it } from "vitest";
import {
  RUN_STATUS_PHRASES,
  pickRunStatusPhrase,
  runStatusPeriod,
} from "./runStatusPhrases";

const at = (hour: number, minute = 0) => new Date(2026, 0, 1, hour, minute);

describe("runStatusPeriod", () => {
  it("按本地时钟分段，边界落在下一段的第一分钟", () => {
    expect(runStatusPeriod(at(4, 59))).toBe("evening");
    expect(runStatusPeriod(at(5, 0))).toBe("earlyMorning");
    expect(runStatusPeriod(at(8, 59))).toBe("earlyMorning");
    expect(runStatusPeriod(at(9, 0))).toBe("forenoon");
    expect(runStatusPeriod(at(11, 29))).toBe("forenoon");
    expect(runStatusPeriod(at(11, 30))).toBe("noon");
    expect(runStatusPeriod(at(13, 29))).toBe("noon");
    expect(runStatusPeriod(at(13, 30))).toBe("afternoon");
    expect(runStatusPeriod(at(17, 59))).toBe("afternoon");
    expect(runStatusPeriod(at(18, 0))).toBe("evening");
    expect(runStatusPeriod(at(23, 59))).toBe("evening");
  });
});

describe("pickRunStatusPhrase", () => {
  it("每个时段都有可用的文案，且组内不重复", () => {
    for (const phrases of Object.values(RUN_STATUS_PHRASES)) {
      expect(phrases.length).toBeGreaterThan(0);
      expect(new Set(phrases).size).toBe(phrases.length);
    }
  });

  it("避开上一句，不会连续两次一样", () => {
    const pool = RUN_STATUS_PHRASES.forenoon;
    for (let i = 0; i < 30; i += 1) {
      const previous = pool[i % pool.length];
      expect(pickRunStatusPhrase("forenoon", previous)).not.toBe(previous);
    }
  });

  it("注入 random 后结果固定（从排除上一句后的池子里取）", () => {
    const pool = RUN_STATUS_PHRASES.noon;
    const previous = pool[0];
    expect(pickRunStatusPhrase("noon", previous, () => 0)).toBe(pool[1]);
    expect(pickRunStatusPhrase("noon", previous, () => 0.999)).toBe(pool[pool.length - 1]);
  });
});
