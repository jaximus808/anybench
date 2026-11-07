import { describe, expect, it } from "vitest";
import { formatSseFrame, SSE_PING, SseParser } from "../src/index.js";

describe("SSE framing", () => {
  it("round-trips frames, including multi-line data", () => {
    const text =
      formatSseFrame({ retry: 1000, id: "7", data: '{"a":1}' }) +
      SSE_PING +
      formatSseFrame({ event: "end", data: "line1\nline2" });
    expect(new SseParser().push(text)).toEqual([
      { retry: 1000, id: "7", data: '{"a":1}' },
      { event: "end", data: "line1\nline2" },
    ]);
  });

  it("handles frames split across chunks and CRLF line endings", () => {
    const p = new SseParser();
    const text = "id: 1\r\ndata: he";
    expect(p.push(text)).toEqual([]);
    expect(p.push("llo\r")).toEqual([]);
    expect(p.push("\n\r\n")).toEqual([{ id: "1", data: "hello" }]);
    expect(p.push("data:x\n\n")).toEqual([{ data: "x" }]);
  });

  it("strips newlines from id and event", () => {
    expect(formatSseFrame({ id: "1\n2", event: "e\nx", data: "d" })).toBe(
      "id: 12\nevent: ex\ndata: d\n\n",
    );
  });
});
