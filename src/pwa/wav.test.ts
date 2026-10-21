import { describe, expect, it } from "vitest";
import { concat, downsample, encodeWav, levelOf } from "./wav";

describe("wav", () => {
  it("brings 48 kHz down to 16 kHz, averaging", () => {
    const input = new Float32Array([0.3, 0.3, 0.3, -0.6, 0, 0, 1]);
    const out = downsample(input, 48_000);
    expect(Array.from(out).map((x) => +x.toFixed(3))).toEqual([0.3, -0.2]);
    // Non-integer ratios cover the input without a gap.
    expect(downsample(new Float32Array(44_100).fill(0.5), 44_100)).toHaveLength(16_000);
    expect(downsample(new Float32Array(44_100).fill(0.5), 44_100).every((x) => Math.abs(x - 0.5) < 1e-6)).toBe(true);
    const low = new Float32Array([1, 2]);
    expect(downsample(low, 16_000)).toBe(low);
  });

  it("writes the 16 kHz mono 16-bit WAV the desktop reads", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]));
    const v = new DataView(wav.buffer);
    const text = (a: number, n: number) => String.fromCharCode(...wav.slice(a, a + n));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it("joins chunks and measures their loudness", () => {
    expect(Array.from(concat([new Float32Array([1]), new Float32Array([2, 3])]))).toEqual([1, 2, 3]);
    expect(levelOf(new Float32Array(10))).toBe(0);
    expect(levelOf(new Float32Array(10).fill(0.05))).toBeCloseTo(0.3);
    expect(levelOf(new Float32Array(10).fill(0.9))).toBe(1);
  });
});
