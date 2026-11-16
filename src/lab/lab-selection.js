// Shared URL state for the unified lab and the legacy pickets link.
export const DEFAULT_ENVIRONMENT = "env-test/obd_4k_q80.jpg"

export function readLabSelection(params) {
	return {
		scene: params.get("scene") === "pickets" ? "pickets" : "artwork",
		model: params.get("model") || "",
		environment: params.get("env") || DEFAULT_ENVIRONMENT,
	}
}

export function labSelectionUrl(href, changes) {
	const url = new URL(href)
	for (const [key, value] of Object.entries(changes)) {
		if (!value || (key === "scene" && value === "artwork")) url.searchParams.delete(key)
		else url.searchParams.set(key, value)
	}
	return url
}

export function picketsLabUrl(href) {
	const url = labSelectionUrl(href, { scene: "pickets" })
	url.pathname = url.pathname.replace(/aa-lab-pickets\.html$/, "aa-lab.html")
	return url
}

/** Scene and asset choices live in the existing sidebar, not separate floating controls. */
export function mountLabSelection(container, selection) {
	container.innerHTML = `
		<h2>Scene</h2>
		<div class="row"><label for="lab-scene">scene</label><select id="lab-scene">
			<option value="artwork">Artwork</option><option value="pickets">Pickets + knot</option>
		</select></div>
		<div id="artwork-selection">
			<div class="row"><label for="lab-model">model</label><select id="lab-model">
				<option value="">Default · False Enlightenment</option>
			</select></div>
			<div class="row"><label for="lab-environment">environment</label><select id="lab-environment"></select></div>
		</div>
		<div id="lab-selection-status" class="note" role="status"></div>
		<div class="note">Scene changes reload the lab. Shift + ←/→ steps through artwork models.</div>`

	const scene = container.querySelector("#lab-scene")
	const model = container.querySelector("#lab-model")
	const environment = container.querySelector("#lab-environment")
	const status = container.querySelector("#lab-selection-status")
	const isPickets = selection.scene === "pickets"
	scene.value = selection.scene
	container.querySelector("#artwork-selection").hidden = isPickets
	if (isPickets) status.textContent = "Grid floor, studio lights and spinning knot; no environment map."

	const navigate = (changes) => { location.href = labSelectionUrl(location.href, changes).href }
	scene.addEventListener("change", () => navigate({ scene: scene.value }))
	model.addEventListener("change", () => navigate({ scene: "artwork", model: model.value }))
	environment.addEventListener("change", () => navigate({ env: environment.value }))

	// Keep direct links visible even if a manifest is unavailable or doesn't list the asset.
	if (selection.model) model.add(new Option(selection.model, selection.model, false, true))
	environment.add(new Option(selection.environment, selection.environment, false, true))

	const loadManifest = async (path) => {
		const response = await fetch(`${import.meta.env.BASE_URL}${path}/manifest.json`)
		if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
		const entries = await response.json()
		if (!Array.isArray(entries)) throw new Error(`${path}: invalid manifest`)
		return entries
	}
	const reportError = (error) => {
		status.textContent += `${status.textContent ? " " : ""}Could not load choices: ${error.message}`
		console.warn("AA lab asset choices", error)
	}

	loadManifest("glass-variants").then((entries) => {
		model.replaceChildren(new Option("Default · False Enlightenment", ""))
		for (const [label, finals] of [["Final artworks", true], ["Glass / compression experiments", false]]) {
			const group = document.createElement("optgroup")
			group.label = label
			for (const entry of entries.filter((entry) => entry.file.startsWith("FINAL__") === finals)) {
				group.append(new Option(`${entry.id} (${(entry.kb / 1024).toFixed(2)} MB)`, entry.file))
			}
			if (group.children.length) model.append(group)
		}
		if (selection.model && !entries.some((entry) => entry.file === selection.model)) {
			model.add(new Option(selection.model, selection.model))
		}
		model.value = selection.model
	}).catch(reportError)

	loadManifest("env-test").then((entries) => {
		environment.replaceChildren()
		for (const entry of entries) {
			environment.add(new Option(entry.label, entry.file ? `env-test/${entry.file}` : DEFAULT_ENVIRONMENT))
		}
		if (![...environment.options].some((option) => option.value === selection.environment)) {
			environment.add(new Option(selection.environment, selection.environment))
		}
		environment.value = selection.environment
	}).catch(reportError)

	window.addEventListener("keydown", (event) => {
		if (isPickets || !event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target.isContentEditable) return
		const index = model.selectedIndex + (event.key === "ArrowRight" ? 1 : -1)
		if (index < 0 || index >= model.options.length) return
		event.preventDefault()
		navigate({ scene: "artwork", model: model.options[index].value })
	})
}
