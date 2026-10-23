import { Box3, MathUtils, Matrix4, Vector4 } from "three";

/** Projects a world-space AABB conservatively, without per-frame allocations. */
export class TemporalAABounds {

    private readonly corner = new Vector4();

    /**
     * Returns false and a full-screen rectangle if projection is unsafe (notably a near-plane intersection).
     * Bounds include transparent geometry: depth alone cannot identify the scratched glass's silhouette.
     */
    project(box: Box3, viewProjection: Matrix4, width: number, height: number, padding: number, target: Vector4): boolean {

        target.set(0, 0, 1, 1);

        if(box.isEmpty() || width <= 0 || height <= 0 || !Number.isFinite(width + height + padding)) {

            return false;

        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for(let i = 0; i < 8; ++i) {

            const p = this.corner.set(
                (i & 1) ? box.max.x : box.min.x,
                (i & 2) ? box.max.y : box.min.y,
                (i & 4) ? box.max.z : box.min.z,
                1
            ).applyMatrix4(viewProjection);

            // Perspective division is not conservative for a box that crosses the eye or near plane.
            if(!Number.isFinite(p.x + p.y + p.z + p.w) || p.w <= 0 || p.z <= -p.w) {

                return false;

            }

            const x = 0.5 * (p.x / p.w + 1);
            const y = 0.5 * (p.y / p.w + 1);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);

        }

        const padX = Math.max(0, padding) / width;
        const padY = Math.max(0, padding) / height;
        target.set(MathUtils.clamp(minX - padX, 0, 1), MathUtils.clamp(minY - padY, 0, 1),
            MathUtils.clamp(maxX + padX, 0, 1), MathUtils.clamp(maxY + padY, 0, 1));
        return true;

    }

}
