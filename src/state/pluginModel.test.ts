import { describe, expect, it } from "vitest";

import type { Plugin } from "../ipc/plugins";
import { blockingFields, fieldValue, fillForDisplay, itemsOf, patternOk, runValues, taskIdFor } from "./pluginModel";

const action = (id: string) => ({ id, label: id, run: ["git"], cwd: null, env: {}, confirm: null, long: false });

const deploy: Plugin = {
  id: "deploy",
  label: null,
  controls: [
    { type: "select", id: "env", label: null, options: ["staging", "prod"], default: "staging" },
    { type: "text", id: "tag", label: null, placeholder: "tag", default: "", pattern: "^v\\d+\\.\\d+\\.\\d+$" },
    { type: "button", action: "go" },
    { type: "checkbox", id: "dry", label: "dry run", default: true, on: "--dry-run", off: "" },
  ],
  actions: [action("lint"), action("go")],
};

describe("plugin model", () => {
  it("draws fields in file order, a button in its place, other actions after", () => {
    const order = itemsOf(deploy).map((i) => (i.kind === "field" ? `f:${i.control.id}` : `a:${i.action.id}`));
    expect(order).toEqual(["f:env", "f:tag", "a:go", "f:dry", "a:lint"]);
  });

  it("shows a stored value only while it still fits the field", () => {
    const [env, tag, , dry] = deploy.controls;
    if (env.type === "button" || tag.type === "button" || dry.type === "button") throw new Error("fixture");
    expect(fieldValue(env, "prod")).toBe("prod");
    expect(fieldValue(env, "qa")).toBe("staging"); // the option went away
    expect(fieldValue(tag, undefined)).toBe("");
    expect(fieldValue(dry, false)).toBe(false);
    expect(fieldValue(dry, "yes")).toBe(true); // wrong type: the default
  });

  it("holds the actions back until a text field matches its pattern", () => {
    expect(blockingFields(deploy, {})).toEqual(["tag"]);
    expect(blockingFields(deploy, { tag: "v1.2" })).toEqual(["tag"]);
    expect(blockingFields(deploy, { tag: "v1.2.3" })).toEqual([]);
    expect(patternOk(null, "anything")).toBe(true);
    // A pattern JavaScript can't read is left to the backend.
    expect(patternOk("(?<", "x")).toBe(true);
  });

  it("sends every field's value as text", () => {
    expect(runValues(deploy, { tag: "a & calc", dry: false })).toEqual({
      env: "staging",
      tag: "a & calc",
      dry: "false",
    });
  });

  it("fills a confirm question the way the backend reads placeholders", () => {
    const stored = { env: "prod", tag: "v1.0.0" };
    expect(fillForDisplay("Deploy {tag} to {env}?", deploy, stored)).toBe("Deploy v1.0.0 to prod?");
    expect(fillForDisplay("{dry} {root} {{tag}} { x }", deploy, stored)).toBe("--dry-run {root} {tag} { x }");
  });

  it("names one task per action", () => {
    expect(taskIdFor("p", "deploy", "go")).toBe("task:p:deploy:go");
  });
});
