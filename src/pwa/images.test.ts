import { describe, expect, it } from "vitest";
import { imagePlan, jpegName, pastedName, SESSION_IMAGE_MAX } from "./images";

describe("pictures before they go up", () => {
  it("sends a readable picture as it is, while it fits", () => {
    expect(imagePlan("image/png", "a.png", 1000, SESSION_IMAGE_MAX)).toBe("keep");
    expect(imagePlan("image/jpeg", "a.jpg", 9_000_000, Infinity)).toBe("keep");
    expect(imagePlan("image/jpeg", "a.jpg", 9_000_000, SESSION_IMAGE_MAX)).toBe("redraw");
  });

  it("redraws what Claude can't read, even unnamed by type", () => {
    expect(imagePlan("image/heic", "IMG_1.HEIC", 100, Infinity)).toBe("redraw");
    expect(imagePlan("", "IMG_1.heic", 100, Infinity)).toBe("redraw");
    expect(imagePlan("image/bmp", "a.bmp", 100, Infinity)).toBe("redraw");
  });

  it("leaves files and SVG alone", () => {
    expect(imagePlan("application/pdf", "a.pdf", 9_000_000, SESSION_IMAGE_MAX)).toBe("keep");
    expect(imagePlan("", "notes", 10, SESSION_IMAGE_MAX)).toBe("keep");
    expect(imagePlan("image/svg+xml", "a.svg", 9_000_000, SESSION_IMAGE_MAX)).toBe("keep");
  });

  it("names pasted pictures and redrawn ones", () => {
    expect(pastedName({ name: "shot.png", type: "image/png" })).toBe("shot.png");
    expect(pastedName({ name: "image.png", type: "image/png" }, 5)).toBe("pasted-5.png");
    expect(pastedName({ name: "", type: "image/jpeg" }, 5)).toBe("pasted-5.jpeg");
    expect(jpegName("IMG_1.HEIC")).toBe("IMG_1.jpg");
    expect(jpegName("a.b.png")).toBe("a.b.jpg");
    expect(jpegName("")).toBe("photo.jpg");
  });
});
