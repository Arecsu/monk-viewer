import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { DEFAULT_ENVIRONMENT, labSelectionUrl, picketsLabUrl, readLabSelection } from "../src/lab/lab-selection.js";

test("the unified lab defaults to artwork and the chosen JPEG environment", () => {
    assert.deepEqual(readLabSelection(new URLSearchParams()), {
        scene: "artwork", model: "", environment: DEFAULT_ENVIRONMENT,
    });
    assert.equal(readLabSelection(new URLSearchParams("scene=unknown")).scene, "artwork");
});

test("artwork and environment direct links remain compatible", () => {
    assert.deepEqual(readLabSelection(new URLSearchParams("model=FINAL__Nomad.glb&env=env-test/obd_4k_full.jpg")), {
        scene: "artwork", model: "FINAL__Nomad.glb", environment: "env-test/obd_4k_full.jpg",
    });
});

test("scene changes preserve renderer parameters and the last artwork/environment", () => {
    const original = "https://example.com/monk-viewer/aa-lab.html?backend=webgpu&fixed=1&smaa=0&msaa=8&preset=legacy&mode=taa%2Bsmaa&model=FINAL__Nomad.glb&env=env-test%2Fobd_4k_full.jpg#settings";
    const pickets = labSelectionUrl(original, { scene: "pickets" });
    assert.equal(readLabSelection(pickets.searchParams).scene, "pickets");
    const artwork = labSelectionUrl(pickets.href, { scene: "artwork" });
    assert.equal(artwork.href, original);
});

test("choosing the default artwork removes the old variant without losing other settings", () => {
    const url = labSelectionUrl("https://example.com/monk-viewer/aa-lab.html?scene=pickets&model=old.glb&backend=webgl", {
        scene: "artwork", model: "",
    });
    assert.equal(url.pathname, "/monk-viewer/aa-lab.html");
    assert.equal(url.search, "?backend=webgl");
});

test("legacy pickets URLs redirect under the same deployment prefix with query and hash intact", () => {
    for (const prefix of ["/", "/monk-viewer/", "/another/prefix/"]) {
        const url = picketsLabUrl(`https://example.com${prefix}aa-lab-pickets.html?backend=webgl&fixed=1&mode=tmr4%2Bsmaa#test`);
        assert.equal(url.pathname, `${prefix}aa-lab.html`);
        assert.equal(url.searchParams.get("scene"), "pickets");
        assert.equal(url.searchParams.get("backend"), "webgl");
        assert.equal(url.searchParams.get("fixed"), "1");
        assert.equal(url.searchParams.get("mode"), "tmr4+smaa");
        assert.equal(url.hash, "#test");
    }
});

test("selectable lab assets exist, are portable files, and exclude the removed HDR", () => {
    for (const directory of ["glass-variants", "env-test"]) {
        const root = new URL(`../public/${directory}/`, import.meta.url);
        const entries = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
        assert.ok(entries.length > 0);
        assert.equal(new Set(entries.map((entry: { file: string }) => entry.file)).size, entries.length);
        for (const entry of entries) {
            const asset = new URL(entry.file, root);
            assert.ok(existsSync(asset), `Missing ${entry.file}`);
            assert.equal(lstatSync(asset).isSymbolicLink(), false, `${entry.file} must not depend on a local symlink`);
            if (directory === "env-test") assert.match(entry.file, /\.jpg$/i);
        }
    }
    assert.equal(existsSync(new URL("../public/env-test/old_bus_depot_8k.hdr", import.meta.url)), false);
});
