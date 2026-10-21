import { describe, expect, it } from "vitest";
import { encode, FRAME, Framer, type Out } from "./converse";

const frame = (amp: number) => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 3));
const samples = (outs: Out[]) => outs.reduce((n, o) => n + ("gap" in o ? o.gap : o.pcm.length), 0);

describe("conversation mode's stream", () => {
  it("sends sound as it is and silence as gaps, every sample accounted for", () => {
    const f = new Framer();
    const outs: Out[] = [];
    // 2 s of quiet, half a second of speech, 2 s of quiet.
    const plan = [...Array(62).fill(0.0005), ...Array(16).fill(0.2), ...Array(62).fill(0.0005)];
    for (const a of plan) outs.push(...f.push(frame(a)));
    const pcm = outs.filter((o) => "pcm" in o).length;
    // The speech, the 4 frames before it and the 10 after it.
    expect(pcm).toBe(16 + 4 + 10);
    // Nothing is lost or doubled: only what's still held back (4 frames, and a
    // gap under 4) is missing.
    const sent = samples(outs);
    expect(plan.length * FRAME - sent).toBeLessThan(8 * FRAME);
    expect(plan.length * FRAME - sent).toBeGreaterThanOrEqual(4 * FRAME);
    // Gaps go out in batches of 4 frames (one shorter before the speech), not a
    // frame at a time.
    const gaps = outs.filter((o) => "gap" in o);
    expect(gaps.length).toBeLessThanOrEqual(Math.ceil(124 / 4) + 1);
  });

  it("follows a noisy room's floor", () => {
    const f = new Framer();
    let pcm = 0;
    for (let i = 0; i < 200; i++) pcm += f.push(frame(0.02)).filter((o) => "pcm" in o).length;
    // Steady noise soon counts as quiet.
    expect(pcm).toBeLessThan(40);
    expect(f.push(frame(0.2)).some((o) => "pcm" in o)).toBe(true);
  });

  it("encodes frames as the desktop reads them", () => {
    const gap = new DataView(encode({ gap: 2048 }));
    expect([gap.getUint8(0), gap.getUint32(1, true), gap.byteLength]).toEqual([1, 2048, 5]);
    const pcm = new DataView(encode({ pcm: Float32Array.from([0, 0.5, -1]) }));
    expect([pcm.getUint8(0), pcm.getInt16(1, true), pcm.getInt16(3, true), pcm.getInt16(5, true)]).toEqual([0, 0, 16384, -32768]);
  });
});
