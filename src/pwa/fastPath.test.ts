import { describe, expect, it } from "vitest";
import { fastPath, lengthOf, timeOf } from "./fastPath";

describe("the phone's fast path (H5)", () => {
  it("reads a length the way it's said", () => {
    expect(lengthOf("10 minutes")).toBe(600);
    expect(lengthOf("ten minutes")).toBe(600);
    expect(lengthOf("twenty five minutes")).toBe(1500);
    expect(lengthOf("an hour and a half")).toBe(5400);
    expect(lengthOf("1 hour 30 minutes")).toBe(5400);
    expect(lengthOf("1h30m")).toBe(5400);
    expect(lengthOf("half an hour")).toBe(1800);
    expect(lengthOf("90 seconds")).toBe(90);
    expect(lengthOf("10-minute")).toBe(600);
    expect(lengthOf("a while")).toBeNull();
  });

  it("reads a time of day", () => {
    expect(timeOf("7")).toBe("07:00");
    expect(timeOf("7:30")).toBe("07:30");
    expect(timeOf("7.30 pm")).toBe("19:30");
    expect(timeOf("6 in the morning")).toBe("06:00");
    expect(timeOf("12 am")).toBe("00:00");
    expect(timeOf("seven pm")).toBe("19:00");
    expect(timeOf("noon")).toBe("12:00");
    expect(timeOf("25:00")).toBeNull();
    expect(timeOf("later")).toBeNull();
  });

  it("takes timers, alarms, the flashlight and media commands", () => {
    expect(fastPath("Set a timer for 10 minutes.")).toEqual({ tool: "phone_set_timer", input: { seconds: 600 }, said: "Timer: 10 min." });
    expect(fastPath("10 minute timer for the pasta")).toEqual({
      tool: "phone_set_timer",
      input: { seconds: 600, label: "pasta" },
      said: "Timer: 10 min for pasta.",
    });
    expect(fastPath("Duck, timer for an hour and a half please")?.input).toEqual({ seconds: 5400 });
    expect(fastPath("set an alarm for 6:45 am")).toEqual({ tool: "phone_set_alarm", input: { time: "06:45" }, said: "Alarm at 06:45." });
    expect(fastPath("alarm at 7 for work")?.input).toEqual({ time: "07:00", label: "work" });
    expect(fastPath("wake me up at 6 in the morning")?.input).toEqual({ time: "06:00" });
    expect(fastPath("turn on the flashlight")).toEqual({ tool: "phone_flashlight", input: { on: true }, said: "Flashlight on." });
    expect(fastPath("torch off")?.input).toEqual({ on: false });
    expect(fastPath("Pause")).toEqual({ tool: "phone_media_control", input: { action: "pause" }, said: "Paused." });
    expect(fastPath("pause the music")?.input).toEqual({ action: "pause" });
    expect(fastPath("next song")?.input).toEqual({ action: "next" });
    expect(fastPath("skip")?.input).toEqual({ action: "next" });
    expect(fastPath("resume")?.input).toEqual({ action: "play" });
  });

  it("leaves anything else to Duck", () => {
    expect(fastPath("play Bohemian Rhapsody")).toBeNull();
    expect(fastPath("pause the build and tell me why it failed")).toBeNull();
    expect(fastPath("remind me in 10 minutes to call mum")).toBeNull();
    expect(fastPath("what's the timer for the oven on the desktop?")).toBeNull();
    expect(fastPath("set a timer")).toBeNull();
    expect(fastPath("")).toBeNull();
  });
});
