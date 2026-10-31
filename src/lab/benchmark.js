// Frame cost for the AA labs, independent of vsync: the live loop is paused, frames are rendered back to back (motion
// keeps advancing, as in the live loop) and the GPU queue is drained, so wall time per frame is the GPU-bound frame
// time whenever the CPU side is cheaper, which the result reports as well.
//
// Live GPU timestamps were tried first and are not trustworthy on Apple GPUs: three's per-pass timestamps overlap
// (summing them counts the same time several times over) and passes bracketing the frame run concurrently with it.

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

async function drain(mgr) {
	if (mgr.backendStatus.selected === 'webgpu') {
		await mgr.renderer.backend.device.queue.onSubmittedWorkDone()
		return
	}
	const gl = mgr.renderer.getContext()
	const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
	gl.flush()
	try {
		while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((resolve) => setTimeout(resolve, 0))
	} finally {
		gl.deleteSync(sync)
	}
}

/**
 * @param {Object} mgr - The lab's manager, rendering.
 * @param {Object} [options]
 * @param {number} [options.frames] - Frames per round.
 * @param {number} [options.rounds] - Rounds; the median is reported.
 * @return {Promise<{msPerFrame: number, fps: number, cpuMsPerFrame: number, frames: number, rounds: number[]}>}
 */
export async function benchmarkFrames(mgr, { frames = 60, rounds = 3 } = {}) {
	const resume = mgr.pauseRendering()
	try {
		const frame = () => { mgr.updateScene(); mgr.pipeline.render() }
		// Warm-up: pipelines, buffers and the first frames' history
		for (let i = 0; i < 10; i++) frame()
		await drain(mgr)

		const walls = [], cpus = []
		for (let round = 0; round < rounds; round++) {
			const start = performance.now()
			for (let i = 0; i < frames; i++) frame()
			const submitted = performance.now()
			await drain(mgr)
			walls.push((performance.now() - start) / frames)
			cpus.push((submitted - start) / frames)
		}
		const msPerFrame = median(walls)
		return { msPerFrame, fps: 1000 / msPerFrame, cpuMsPerFrame: median(cpus), frames, rounds: walls }
	} finally {
		if (resume) mgr.resumeRendering()
	}
}
