import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GT7_PARAMETERS, gt7Constants, gt7ToneMapping } from "../src/postprocessing/GT7ToneMappingEffect.ts";

// Generated from Polyphony Digital's gt7_tone_mapping.cpp (initializeAsSDR, ICtCp) built with double instead of float,
// so the comparison isn't limited by float32 rounding near the chroma fade. Linear Rec.2020 in and out.
const reference = JSON.parse(readFileSync(new URL("./fixtures/gt7-tone-mapping-reference.json", import.meta.url), "utf8"));

test("SDR constants match the reference", () => {
    const constants = gt7Constants();
    for(const [key, value] of Object.entries(reference.constants)) {
        assert.ok(Math.abs(constants[key as keyof typeof constants] - (value as number)) < 1e-5, key);
    }
});

test("tone mapping matches the reference implementation", () => {
    for(const [input, expected] of reference.cases) {
        const output = gt7ToneMapping(input);
        output.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1e-6, `${input} → ${output}, expected ${expected}`));
    }
});

test("highlight hardness: GT7's clips to white, 0 rolls off towards it", () => {
    const grey = (x: number, alpha: number) => gt7ToneMapping([x, x, x], { ...GT7_PARAMETERS, alpha })[0];
    // Where GT7 has clipped, the softer roll-off still has room for detail
    assert.equal(grey(4, GT7_PARAMETERS.alpha), 1);
    assert.ok(grey(4, 0) < 0.95);
    let previous = 0;
    for(let x = 0.01; x < 1000; x *= 1.1) {
        const y = grey(x, 0);
        assert.ok(y <= 1 && y >= previous, `${x} → ${y}`);
        previous = y;
    }
    // Same up to where the shoulder starts
    assert.equal(grey(1, 0), grey(1, GT7_PARAMETERS.alpha));
});
