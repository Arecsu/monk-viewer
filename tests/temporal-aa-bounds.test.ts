import assert from "node:assert/strict";
import test from "node:test";
import { Box3, Matrix4, PerspectiveCamera, Vector3, Vector4 } from "three";
import { TemporalAABounds } from "../src/postprocessing/TemporalAABounds.ts";

const projector = new TemporalAABounds();
const full = [0, 0, 1, 1];
const box = new Box3(new Vector3(-0.2, -0.3, -0.01), new Vector3(0.2, 0.3, 0.01));

function viewProjection(camera: PerspectiveCamera): Matrix4 {
    camera.updateMatrixWorld();
    return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

function cameraAt(x = 0, y = 0, z = 1): PerspectiveCamera {
    const camera = new PerspectiveCamera(50, 1.5, 0.03, 100);
    camera.position.set(x, y, z);
    camera.lookAt(0, 0, 0);
    return camera;
}

test("projects all box corners conservatively through camera orbit and model rotation", () => {
    const target = new Vector4();
    for(const aspect of [0.4, 1, 1.5, 3]) {
        for(let step = 0; step < 24; ++step) {
            const angle = step * Math.PI / 12;
            const camera = cameraAt(Math.sin(angle), 0.25, Math.cos(angle));
            camera.aspect = aspect;
            camera.updateProjectionMatrix();
            const vp = viewProjection(camera);
            const world = box.clone().applyMatrix4(new Matrix4().makeRotationY(angle / 2));
            assert.equal(projector.project(world, vp, 900, 600, 4, target), true);
            for(let i = 0; i < 8; ++i) {
                const p = new Vector3((i & 1) ? world.max.x : world.min.x,
                    (i & 2) ? world.max.y : world.min.y, (i & 4) ? world.max.z : world.min.z).applyMatrix4(vp);
                const x = Math.max(0, Math.min(1, (p.x + 1) / 2));
                const y = Math.max(0, Math.min(1, (p.y + 1) / 2));
                assert.ok(x >= target.x && x <= target.z && y >= target.y && y <= target.w);
            }
        }
    }
});

test("padding uses physical render pixels, not CSS pixels", () => {
    const vp = viewProjection(cameraAt());
    const unpadded = new Vector4(), padded = new Vector4(), retina = new Vector4();
    projector.project(box, vp, 900, 600, 0, unpadded);
    projector.project(box, vp, 900, 600, 4, padded);
    projector.project(box, vp, 1800, 1200, 4, retina);
    assert.ok(Math.abs(unpadded.x - padded.x - 4 / 900) < 1e-12);
    assert.ok(Math.abs(unpadded.y - padded.y - 4 / 600) < 1e-12);
    assert.ok(Math.abs(unpadded.x - retina.x - 4 / 1800) < 1e-12);
});

test("falls back for near-plane crossings, objects behind the eye, and invalid input", () => {
    const vp = viewProjection(cameraAt());
    const target = new Vector4();
    const crossing = new Box3(new Vector3(-0.1, -0.1, 0.95), new Vector3(0.1, 0.1, 0.98));
    const behind = new Box3(new Vector3(-0.1, -0.1, 1.1), new Vector3(0.1, 0.1, 1.2));
    for(const candidate of [crossing, behind, new Box3()]) {
        target.set(0.4, 0.4, 0.6, 0.6);
        assert.equal(projector.project(candidate, vp, 900, 600, 4, target), false);
        assert.deepEqual(target.toArray(), full);
    }
    for(const [width, height, padding] of [[0, 600, 4], [900, 0, 4], [NaN, 600, 4], [900, 600, Infinity]]) {
        assert.equal(projector.project(box, vp, width, height, padding, target), false);
        assert.deepEqual(target.toArray(), full);
    }
    const invalid = vp.clone();
    invalid.elements[0] = NaN;
    assert.equal(projector.project(box, invalid, 900, 600, 4, target), false);
    assert.deepEqual(target.toArray(), full);
});

test("off-screen objects produce a clamped, finite rectangle", () => {
    const vp = viewProjection(cameraAt());
    const target = new Vector4();
    const offscreen = box.clone().translate(new Vector3(10, 0, 0));
    assert.equal(projector.project(offscreen, vp, 900, 600, 4, target), true);
    assert.equal(target.x, 1);
    assert.equal(target.z, 1);
    assert.ok(target.y >= 0 && target.w <= 1);
});
