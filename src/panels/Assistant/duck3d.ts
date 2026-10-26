// The ASCII duck: a 3D rubber duck drawn in characters. The duck is a signed
// distance field (ellipsoids and a sphere, smooth-joined), raymarched once per
// character cell with an orthographic camera; the shade at the hit picks the
// character. Pure: no DOM, so the frame math is testable.
//
// Model space: +x is where the beak points, +y is up, z is the duck's side. The
// camera sits at -z looking toward +z.

export type DuckMode = "idle" | "listening" | "thinking" | "talking";

export const MAT_BODY = 0;
export const MAT_BEAK = 1;
/** The sunglasses' lenses, which carry the eyes' catchlight. */
export const MAT_EYE = 2;
/** The sunglasses' bridge and arms. */
export const MAT_SHADES = 3;
export const MAT_TIE = 4;
export const MAT_KNOT = 5;

/** Where the duck is and what its face does, set per frame by `Animator`. */
export interface Pose {
  /** Turn about the vertical axis, radians; 0 = profile, beak to the right. */
  yaw: number;
  /** Roll of the whole duck about the view axis. */
  rock: number;
  /** Vertical offset. */
  bob: number;
  /** Head tilt at the neck; positive looks up. */
  nod: number;
  /** Beak opening, 0..1. */
  mouth: number;
  /** Eyelids, 1 = open, 0 = shut. Behind the sunglasses it doesn't show. */
  blink: number;
}

export interface Frame {
  cols: number;
  rows: number;
  /** Shade 0..1 per cell, row-major; -1 = no duck there. */
  lum: Float32Array;
  mat: Uint8Array;
}

// ── the model ────────────────────────────────────────────────────────────────

/** Which way the lenses face, about the vertical axis: along the head's surface
 *  where the eyes were. */
const LENS_C = Math.cos(0.646);
const LENS_S = Math.sin(0.646);

let pose: Pose;
let mat = MAT_BODY;
/** Which eye `scene` hit last: -1 or 1. */
let eyeSide = 1;
/** The normal the catchlight reads at the lens `scene` hit last, model space: a
 *  tighter curve than the lens's own, so the glint is a spot that slides. */
let lensNx = 0;
let lensNy = 0;
let lensNz = 0;
let rx = 0;
let ry = 0;

const len3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

function ellipsoid(px: number, py: number, pz: number, ax: number, ay: number, az: number): number {
  const k0 = len3(px / ax, py / ay, pz / az);
  const k1 = len3(px / (ax * ax), py / (ay * ay), pz / (az * az));
  return k1 === 0 ? -Math.min(ax, ay, az) : (k0 * (k0 - 1)) / k1;
}

/** Distance to the capsule from (ax, ay, az) to (bx, by, bz) of radius `r`. */
function capsule(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const qx = px - ax;
  const qy = py - ay;
  const qz = pz - az;
  const h = Math.min(1, Math.max(0, (qx * dx + qy * dy + qz * dz) / (dx * dx + dy * dy + dz * dz)));
  return len3(qx - dx * h, qy - dy * h, qz - dz * h) - r;
}

function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Rotates (x, y) about (cx, cy) by `a` into `rx`, `ry`. */
function rotZ(x: number, y: number, cx: number, cy: number, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  rx = cx + dx * c - dy * s;
  ry = cy + dx * s + dy * c;
}

/** Distance to the duck from a model-space point; sets `mat` to what's nearest. */
function scene(x: number, y: number, z: number): number {
  let d = ellipsoid(x, y + 0.15, z, 1.0, 0.6, 0.76); // body
  rotZ(x, y, -0.85, 0.12, 0.6);
  d = smoothMin(d, ellipsoid(rx + 0.85, ry - 0.12, z, 0.4, 0.22, 0.3), 0.3); // tail
  rotZ(x, y, 0, 0, 0.18);
  d = smoothMin(d, ellipsoid(rx + 0.12, ry + 0.02, Math.abs(z) - 0.66, 0.55, 0.26, 0.13), 0.12); // wings
  d = Math.max(d, -(y + 0.6)); // flat bottom
  rotZ(x, y, 0.45, 0.3, -pose.nod); // the head turns at the neck
  const hx = rx;
  const hy = ry;
  d = smoothMin(d, len3(hx - 0.5, hy - 0.62, z) - 0.46, 0.22);
  mat = MAT_BODY;
  // The beak's halves hinge at the face.
  rotZ(hx, hy, 0.88, 0.5, -0.18 * pose.mouth);
  const upper = ellipsoid(rx - 1.08, ry - 0.54, z, 0.3, 0.085, 0.2);
  rotZ(hx, hy, 0.88, 0.5, 0.5 * pose.mouth);
  const lower = ellipsoid(rx - 1.04, ry - 0.45, z, 0.25, 0.065, 0.16);
  const beak = Math.min(upper, lower);
  if (beak < d) {
    d = beak;
    mat = MAT_BEAK;
  }
  const az = Math.abs(z);
  // Sunglasses: a flat lens over each eye, turned to face along the head, with a
  // bridge over the front and arms back along the sides. They and the tie are
  // skipped where their bounding sphere is farther than what's already there.
  if (len3(hx - 0.5, hy - 0.62, z) - 0.58 < d) {
    const lx = hx - 0.855;
    const ly = hy - 0.77;
    const lz = az - 0.268;
    const lens = ellipsoid(lx * LENS_C + lz * LENS_S, ly, lz * LENS_C - lx * LENS_S, 0.04, 0.13, 0.16);
    if (lens < d) {
      d = lens;
      mat = MAT_EYE;
      eyeSide = z < 0 ? -1 : 1;
      const gx = lx + 0.13 * LENS_C;
      const gz = (lz + 0.13 * LENS_S) * eyeSide;
      const nc = Math.cos(pose.nod);
      const ns = Math.sin(pose.nod);
      lensNx = gx * nc - ly * ns;
      lensNy = gx * ns + ly * nc;
      lensNz = gz;
    }
    const frame = Math.min(
      len3(hx - 0.95, hy - 0.81, Math.max(az - 0.14, 0)) - 0.025,
      capsule(hx, hy, az, 0.76, 0.82, 0.39, 0.42, 0.83, 0.45, 0.018),
    );
    if (frame < d) {
      d = frame;
      mat = MAT_SHADES;
    }
  }
  // The bow tie sits on the body at the neck, so it doesn't nod with the head.
  if (len3(x - 0.85, y - 0.26, z) - 0.33 < d) {
    const tx = x - 0.85;
    const ty = y - 0.26;
    const knot = ellipsoid(tx - 0.02, ty, z, 0.065, 0.065, 0.06);
    const wings = ellipsoid(tx, ty, az - 0.16, 0.05, 0.1, 0.13);
    if (knot < d && knot <= wings) {
      d = knot;
      mat = MAT_KNOT;
    } else if (wings < d) {
      d = wings;
      mat = MAT_TIE;
    }
  }
  return d;
}

// ── the renderer ─────────────────────────────────────────────────────────────

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const n = len3(x, y, z);
  return [x / n, y / n, z / n];
};
const LIGHT = unit(-0.45, 0.7, -0.7);
const HALF = unit(LIGHT[0], LIGHT[1], LIGHT[2] - 1);
/** The eyes' catchlight follows the camera, not the light: up and left of an
 *  eye's middle, facing you. */
const GLINT = unit(-0.45, 0.55, -1);
/** Radius of a sphere at (0, 0.25, 0) that holds the duck in every pose. */
const BOUND = 1.7;
/** Eye cells this frame: how squarely each faces `GLINT`, and which eye it is. */
let glintDot = new Float32Array(0);
let glintSide = new Int8Array(0);

/** Renders the duck in `pose` into `cols` x `rows` cells, each `cellAspect`
 *  (width / height) wide. Reuses `out` when it has the same size. */
export function render(p: Pose, cols: number, rows: number, cellAspect: number, out?: Frame): Frame {
  pose = p;
  const n = cols * rows;
  const f = out && out.lum.length === n && out.cols === cols ? out : { cols, rows, lum: new Float32Array(n), mat: new Uint8Array(n) };
  const viewH = 2.55;
  const centerY = 0.22;
  const viewW = (viewH * cols * cellAspect) / rows;
  // Rays go along +z in the world; turned into model space by the yaw.
  const c = Math.cos(-p.yaw);
  const s = Math.sin(-p.yaw);
  const cr = Math.cos(-p.rock);
  const sr = Math.sin(-p.rock);
  const eps = 0.002;
  if (glintDot.length < n) {
    glintDot = new Float32Array(n);
    glintSide = new Int8Array(n);
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sx = ((i + 0.5) / cols - 0.5) * viewW;
      let sy = (0.5 - (j + 0.5) / rows) * viewH + centerY - p.bob;
      const tx = sx * cr - sy * sr;
      sy = sx * sr + sy * cr;
      sx = tx;
      const ox = sx * c - 3 * s;
      const oz = -sx * s - 3 * c;
      const idx = j * cols + i;
      // March only inside a sphere around the duck; most cells miss it outright.
      const half = ox * s + oz * c;
      const disc = half * half - (ox * ox + (sy - 0.25) ** 2 + oz * oz - BOUND * BOUND);
      let hit = false;
      let t = 0;
      if (disc > 0) {
        t = -half - Math.sqrt(disc);
        const end = -half + Math.sqrt(disc);
        for (let k = 0; k < 48 && t < end; k++) {
          const d = scene(ox + s * t, sy, oz + c * t);
          if (d < 0.004) {
            hit = true;
            break;
          }
          t += d * 0.9;
        }
      }
      glintSide[idx] = 0;
      if (!hit) {
        f.lum[idx] = -1;
        continue;
      }
      const px = ox + s * t;
      const pz = oz + c * t;
      scene(px, sy, pz);
      const m = mat;
      const side = eyeSide;
      const gx = lensNx;
      const gy = lensNy;
      const gz = lensNz;
      // Tetrahedral normal in model space, turned back into the world.
      const a = scene(px + eps, sy - eps, pz - eps);
      const b = scene(px - eps, sy - eps, pz + eps);
      const e = scene(px - eps, sy + eps, pz - eps);
      const g = scene(px + eps, sy + eps, pz + eps);
      let nx = a - b - e + g;
      let ny = -a - b + e + g;
      let nz = -a + b - e + g;
      const nl = len3(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const wx = nx * c - nz * s;
      const wz = nx * s + nz * c;
      const wnx = wx * cr + ny * sr;
      const wny = -wx * sr + ny * cr;
      let l: number;
      if (m === MAT_EYE) {
        // The lens is flat; the glint reads a rounder normal, turned like the rest.
        const gl = len3(gx, gy, gz) || 1;
        const gwx = (gx * c - gz * s) / gl;
        const gwz = (gx * s + gz * c) / gl;
        const gwy = gy / gl;
        glintDot[idx] = (gwx * cr + gwy * sr) * GLINT[0] + (-gwx * sr + gwy * cr) * GLINT[1] + gwz * GLINT[2];
        glintSide[idx] = side;
        l = 0.04;
      } else if (m === MAT_SHADES) {
        l = 0.04;
      } else {
        const diff = Math.max(0, wnx * LIGHT[0] + wny * LIGHT[1] + wz * LIGHT[2]);
        const spec = Math.max(0, wnx * HALF[0] + wny * HALF[1] + wz * HALF[2]) ** 22;
        const rim = (1 - Math.max(0, -wz)) ** 3 * 0.25;
        l = 0.12 + diff * 0.72 + rim + spec * 0.45;
      }
      f.lum[idx] = Math.min(1, l);
      f.mat[idx] = m;
    }
  }
  catchlights(f);
  return f;
}

/** Lights the eye cells facing the camera's glint, and always the best one of an
 *  eye that shows (3+ cells), so the eyes shine at every turn instead of only
 *  when one happens to face the glint. */
function catchlights(f: Frame): void {
  for (const side of [-1, 1]) {
    let cells = 0;
    let best = -1;
    for (let i = 0; i < f.lum.length; i++) {
      if (glintSide[i] !== side) continue;
      cells++;
      if (best < 0 || glintDot[i] > glintDot[best]) best = i;
    }
    if (cells < 3) continue; // a sliver of an eye stays dark
    for (let i = 0; i < f.lum.length; i++) {
      if (glintSide[i] === side && (i === best || glintDot[i] > 0.9)) f.lum[i] = 1;
    }
  }
}

// ── the animation ────────────────────────────────────────────────────────────

/** The three-quarter view the duck rests in, beak toward you and to the right. */
const FACING = 0.62;

const angleTo = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** A stand-in for speech loudness: syllables at ~4.4 Hz, gated into words. */
export function fakeSpeech(t: number): number {
  const syllable = Math.max(0, Math.sin(2 * Math.PI * 4.4 * t + 2 * Math.sin(1.3 * t)));
  const word = Math.sin(1.7 * t) + 0.6 * Math.sin(0.53 * t + 1) > -0.45 ? 1 : 0;
  return syllable ** 0.6 * word * (0.65 + 0.35 * Math.sin(0.9 * t) ** 2);
}

/** Moves a pose toward what each mode looks like, easing between modes: the duck
 *  spins while thinking and turns the short way back to face you after. */
export class Animator {
  pose: Pose = { yaw: FACING, rock: 0, bob: 0, nod: 0, mouth: 0, blink: 1 };
  private nextBlink = 2;
  private blinkAt = -1;

  /** Advances to time `t` (seconds) by `dt`. `level` is the speech loudness 0..1
   *  while talking; absent, a fake rhythm moves the beak. */
  step(t: number, dt: number, mode: DuckMode, level?: number): Pose {
    const p = this.pose;
    let yaw = FACING;
    let mouth = 0;
    let nod = 0;
    let bob = 0;
    let rock = 0;
    if (mode === "idle") {
      yaw = FACING + 0.35 * Math.sin(t * 0.45);
      bob = 0.03 * Math.sin(t * 1.6);
      rock = 0.03 * Math.sin(t * 0.8);
      nod = 0.05 * Math.sin(t * 0.7);
    } else if (mode === "listening") {
      yaw = FACING - 0.2 + 0.05 * Math.sin(t * 0.9);
      nod = 0.12 + 0.04 * Math.sin(t * 2.4);
      rock = -0.07;
      bob = 0.015 * Math.sin(t * 2.4);
    } else if (mode === "thinking") {
      bob = 0.06 * Math.abs(Math.sin(t * 3));
      nod = -0.06;
    } else {
      yaw = FACING + 0.12 * Math.sin(t * 0.6);
      mouth = level ?? fakeSpeech(t);
      nod = 0.1 * p.mouth + 0.03 * Math.sin(t * 1.3);
      bob = 0.025 * p.mouth;
      rock = 0.03 * Math.sin(t * 0.7);
    }
    if (mode === "thinking") p.yaw = (p.yaw + 2 * dt) % (2 * Math.PI);
    else p.yaw += angleTo(yaw, p.yaw) * (1 - Math.exp(-dt * 4));
    p.mouth += (mouth - p.mouth) * (1 - Math.exp(-dt * 28));
    const k = 1 - Math.exp(-dt * 6);
    p.nod += (nod - p.nod) * k;
    p.bob += (bob - p.bob) * k;
    p.rock += (rock - p.rock) * k;
    if (t > this.nextBlink) {
      this.blinkAt = t;
      this.nextBlink = t + 2 + Math.random() * 4;
    }
    const b = (t - this.blinkAt) / 0.16;
    p.blink = b >= 0 && b <= 1 ? Math.abs(b * 2 - 1) : 1;
    return p;
  }
}
