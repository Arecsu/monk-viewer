import { defineConfig } from "vite";
import path from "path";

// Common chunks configuration
const manualChunks = {
  manualChunks(id) {
    switch (true) {
      case id.includes("shared-orbitcontrols"):
        return "shared-orbitcontrols";
      case id.includes("node_modules/three"):
        return "vendor-three";
      case id.includes("gainmap-js"):
        return "gainmap-js";
      case id.includes("postprocessing"):
        return "postprocessing"
    }
  },
};

export default defineConfig({
  base: "/monk-viewer/",
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        "offscreencanvas-worker-orbitcontrol": path.resolve(
          __dirname,
          "src/offscreencanvas-worker-orbitcontrol.js",
        ),
      },
      output: manualChunks,
    },
  },
  worker: {
    format: "es",
    plugins: [],
    rollupOptions: {
      output: manualChunks,
    },
  },
});
