"use client";
// The hero background: a field of trial cells. A run sweeps across it left to right: cells
// ahead are queued, the band is running (amber), and behind it each cell resolves to pass or
// fail. It is the product's own unit at a scale no single run would have, so the motion means
// something. Decorative: aria-hidden, static under prefers-reduced-motion, and skipped in jsdom.
import { useEffect, useRef } from "react";

const CELL = 9;
const GAP = 4;
const PITCH = CELL + GAP;

function readVar(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function TrialField({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof navigator === "undefined" || /jsdom/i.test(navigator.userAgent)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const colors = {
      queued: readVar(canvas, "--queued", "#262b22"),
      run: readVar(canvas, "--accent", "#ffb547"),
      pass: readVar(canvas, "--pass", "#7bd88f"),
      fail: readVar(canvas, "--fail", "#ff6b5a"),
    };

    let cols = 0;
    let rows = 0;
    // Per cell: resolve offset (where in the sweep it lands), outcome, and run length.
    let jitter = new Float32Array(0);
    let outcome = new Uint8Array(0);
    let raf = 0;
    let start = performance.now();
    const SWEEP_MS = 14000;

    const seed = () => {
      jitter = new Float32Array(cols * rows);
      outcome = new Uint8Array(cols * rows);
      for (let i = 0; i < jitter.length; i++) {
        jitter[i] = Math.random() * 0.22;
        outcome[i] = Math.random() < 0.16 ? 2 : 1;
      }
    };

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / PITCH);
      rows = Math.ceil(height / PITCH);
      seed();
    };

    const draw = (now: number) => {
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);
      let p = ((now - start) % SWEEP_MS) / SWEEP_MS; // 0..1 sweep position
      if (reduce) p = 0.62;
      if (!reduce && now - start > SWEEP_MS * 3) {
        start = now;
        seed();
      }
      const band = 0.12;
      for (let c = 0; c < cols; c++) {
        const x = c * PITCH;
        const colPos = c / cols;
        for (let r = 0; r < rows; r++) {
          const i = c * rows + r;
          const lands = colPos + jitter[i]!; // when this cell resolves
          const ahead = p * (1 + band + 0.22) - band;
          let color: string;
          let alpha: number;
          if (lands > ahead + band) {
            color = colors.queued;
            alpha = 0.9;
          } else if (lands > ahead) {
            color = colors.run;
            const flicker = reduce ? 0.7 : 0.55 + 0.45 * Math.sin(now / 160 + i);
            alpha = 0.35 + 0.5 * flicker;
          } else {
            color = outcome[i] === 2 ? colors.fail : colors.pass;
            alpha = outcome[i] === 2 ? 0.55 : 0.28;
          }
          ctx.globalAlpha = alpha;
          ctx.fillStyle = color;
          ctx.fillRect(x, r * PITCH, CELL, CELL);
        }
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(draw);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(draw);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
