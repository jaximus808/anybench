// TDM-244 [20.7]: Anybench's model tokens are a real charge now (at cost + markup, as used). The
// Go screen's estimate shows a "Model tokens (ours): at cost + 20%" line (the markup from the
// API), and when Go needs a card for them it says why in the server's words; a refused Go shows
// the 402's plain-words message.
import type { RunEstimate } from "@anybench/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { bpsPercent, estimateCopy } from "../components/live/estimate-copy";
import { EstimateBreakdown } from "../components/live/RunEstimate";
import { GoFailureText } from "../components/live/GoBar";

const RUN_ID = "0192f5d0-0000-7000-8000-000000000244";
const NEED_CARD =
  "This kit uses Anybench's model tokens. Add your own model key or a card to continue.";

function estimate(over: Partial<RunEstimate> = {}): RunEstimate {
  return {
    run_id: RUN_ID as RunEstimate["run_id"],
    kit_origin: "generated",
    price: "paid",
    total_micro_usd: 2_496_800n,
    normal: {
      run_fee_micro_usd: 2_000_000n,
      compute: {
        computers: 12,
        trials: 12,
        blocks: 12,
        block_seconds: 600,
        charge_micro_usd: 496_800n,
      },
      total_micro_usd: 2_496_800n,
      managed_tokens: { contenders: ["claude-code"], markup_bps: 2000 },
    },
    tokens: {
      byok_providers: [],
      byok_ceiling_micro_usd: null,
      managed_contenders: ["claude-code"],
    },
    free_run: null,
    card_needed: true,
    card_message: NEED_CARD,
    ...over,
  };
}

afterEach(cleanup);

describe("managed tokens on the Go screen (TDM-244)", () => {
  it("bpsPercent: basis points as a percentage, no float", () => {
    expect(bpsPercent(2000)).toBe("20%");
    expect(bpsPercent(1250)).toBe("12.5%");
    expect(bpsPercent(1205)).toBe("12.05%");
    expect(bpsPercent(0)).toBe("0%");
  });

  it("adds a 'Model tokens (ours): at cost + 20%' line and says why a card is needed", () => {
    const c = estimateCopy(estimate());
    const line = c.lines.find((l) => l.key === "managed_tokens");
    expect(line).toMatchObject({ label: "Model tokens (ours)", amount: "at cost + 20%" });
    expect(c.managed).toContain("billed as used at cost + 20%");
    expect(c.card).toBe(NEED_CARD);

    render(<EstimateBreakdown estimate={estimate()} />);
    expect(screen.getByText("Model tokens (ours)")).toBeTruthy();
    expect(screen.getByText("at cost + 20%")).toBeTruthy();
    expect(screen.getByTestId("estimate-card").textContent).toBe(NEED_CARD);
  });

  it("no managed contenders: no tokens line, and the generic card words", () => {
    const c = estimateCopy(
      estimate({
        normal: { ...estimate().normal, managed_tokens: null },
        tokens: {
          byok_providers: ["anthropic"],
          byok_ceiling_micro_usd: null,
          managed_contenders: [],
        },
        card_message: null,
      }),
    );
    expect(c.lines.map((l) => l.key)).toEqual(["run_fee", "compute", "total"]);
    expect(c.card).toBe("A card is needed to start it.");
  });

  it("a refused Go shows the 402's own message for managed tokens", () => {
    render(
      <GoFailureText
        failure={{
          kind: "payment",
          href: "/billing?run=x",
          reason: "managed_tokens_need_card",
          message: NEED_CARD,
          freeRun:
            "A free run uses your own model key, but a contender in this test plan runs on Anybench's tokens.",
        }}
      />,
    );
    expect(screen.getByText(new RegExp("This kit uses Anybench's model tokens"))).toBeTruthy();
    expect(screen.queryByText(/A free run uses your own model key/)).toBeNull();
  });
});
