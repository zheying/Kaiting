import { describe, expect, it } from "vitest";
import { advanceScan, beginScan, type ScanOutcome, type ScanState } from "../prototypes/listening-room/src/prototype-state";

describe("原型扫描流程", () => {
  it.each<ScanOutcome>(["complete", "partial", "empty"])("%s 扫描进度单调增加，最终保留对应结果", (outcome) => {
    let scan = beginScan("/music/Albums", outcome);
    for (let step = 0; step < 12; step++) {
      const next = advanceScan(scan);
      expect(next.processed).toBeGreaterThanOrEqual(scan.processed);
      expect(next.processed).toBeLessThanOrEqual(scan.total);
      expect(next.path).toBe("/music/Albums");
      scan = next;
    }
    expect(scan.status).toBe(outcome);
    expect(scan.processed).toBe(scan.total);
  });
  it("中断后停止进度，重新扫描从零开始", () => {
    const interrupted: ScanState = { ...advanceScan(beginScan("/music")), status: "interrupted" };
    expect(advanceScan(interrupted)).toBe(interrupted);
    const retried = beginScan(interrupted.path);
    expect(retried.status).toBe("running");
    expect(retried.processed).toBe(0);
    expect(interrupted.processed).toBeGreaterThan(0);
  });
});


import * as state from "../prototypes/listening-room/src/prototype-state";
import { roomStateContract } from "./support/room-state-contract.js";
roomStateContract(state);
