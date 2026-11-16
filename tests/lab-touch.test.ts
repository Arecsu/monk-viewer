import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the lab canvas owns touch gestures without disabling sidebar scrolling", () => {
    const css = readFileSync(new URL("../src/lab/lab-panel.css", import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const gestureOwners = rules
        .filter(([, , declarations]) => /\btouch-action\s*:\s*none\s*;/.test(declarations))
        .flatMap(([, selectors]) => selectors.split(",").map((selector) => selector.trim()));

    assert.deepEqual(gestureOwners, ["#c"], "Only the interactive canvas should suppress native gestures");
    const panel = rules.find(([, selectors]) => selectors.trim() === "#panel");
    assert.ok(panel);
    assert.match(panel[2], /\boverflow-y\s*:\s*auto\s*;/);
});
