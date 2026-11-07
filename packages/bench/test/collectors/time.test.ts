import { describe, expect, it } from "vitest";
import { collectTime, parseElapsed, parseTimeReport } from "../../src/collectors/time.js";
import { fixture, row, value } from "./fixture.js";

describe("time collector (/usr/bin/time -v, real GNU time 1.9 output)", () => {
  it("parses wall, CPU and peak RSS from a successful run", () => {
    const rows = collectTime(fixture("time/time-v.txt"));
    expect(value(rows, "wall_s")).toBe(0.69);
    expect(value(rows, "user_cpu_s")).toBe(0.58);
    expect(value(rows, "sys_cpu_s")).toBe(0.2);
    expect(value(rows, "cpu_s")).toBe(0.78);
    expect(value(rows, "cpu_percent")).toBe(112);
    expect(value(rows, "peak_rss_bytes")).toBe(9116 * 1024);
    expect(value(rows, "minor_page_faults")).toBe(1743);
    expect(value(rows, "fs_outputs")).toBe(58192);
    expect(value(rows, "exit_code")).toBe(0);
    for (const m of rows) {
      expect(m).toMatchObject({ level: "trial", collector: "time" });
      expect(m.gate_id).toBeUndefined();
    }
    expect(row(rows, "peak_rss_bytes").unit).toBe("bytes");
  });

  it("reads the exit status of a failing command", () => {
    const r = parseTimeReport(fixture("time/time-v-nonzero.txt"));
    expect(r.exit_status).toBe(3);
    expect(r.command).toContain("exit 3");
    expect(value(collectTime(fixture("time/time-v-nonzero.txt")), "exit_code")).toBe(3);
  });

  it("handles signals, ?% CPU and long elapsed times", () => {
    const text = fixture("time/time-v.txt")
      .replace("Percent of CPU this job got: 112%", "Percent of CPU this job got: ?%")
      .replace("0:00.69", "1:02:03")
      .replace(/^/, "Command terminated by signal 9\n");
    const rows = collectTime(text);
    expect(value(rows, "wall_s")).toBe(3723);
    expect(value(rows, "term_signal")).toBe(9);
    expect(rows.some((m) => m.name === "cpu_percent")).toBe(false);
    expect(parseElapsed("2:05.50")).toBe(125.5);
    expect(() => parseElapsed("soon")).toThrow();
  });

  it("refuses text that is not a time -v report", () => {
    expect(() => collectTime("hello\n")).toThrow(/missing/);
  });
});
