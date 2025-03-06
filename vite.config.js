import { defineConfig } from "vite";
import path from "path";
import { version } from "./package.json"; // Import your version

const manualChunks = {
  manualChunks(id) {
    switch (true) {
      case id.includes("shared-orbitcontrols"):
        return "shared-orbitcontrols";
      case id.includes("node_modules/three"):
        return "vendor-three";
      case id.includes("gainmap-js"):
        return "gainmap-js";
      case id.includes("node_modules/postprocessing"):
        return "postprocessing"
      // case id.includes("renderer"):
        // return "renderer"
    }
  },
};

function workerChunkPlugin() {
  return {
    name: "worker-chunk-plugin",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source.endsWith("?worker")) {
        const resolved = await this.resolve(source.split("?")[0], importer);
        return "\0" + resolved?.id + "?worker-chunk";
      }
    },
    load(id) {
      if (id.startsWith("\0") && id.endsWith("?worker-chunk")) {
        const referenceId = this.emitFile({
          type: "chunk",
          id: id.slice(1).split("?")[0],
        });
        return `
          export default function WorkerWrapper() {
            return new Worker(
              import.meta.ROLLUP_FILE_URL_${referenceId},
              { type: "module" }
            );
          }
        `;
      }
    },
  };
}

export default defineConfig({
  base: "/monk-viewer/",
  build: {
    minify: true, // Adjust based on your needs
    modulePreload: false, // Avoids document references
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Only rename the main entry point to monk-viewer
          // ignore the css file
          if (chunkInfo.name === 'main') {
            return `assets/monk-viewer-${version}.js`;
          }
          return `assets/[name]-${version}.js`;
        },
        chunkFileNames: `assets/[name]-${version}.js`,
        assetFileNames: `assets/[name]-${version}.[ext]`
      },
    },
  },
  worker: {
    format: "es",
    // rollupOptions: {
      // output: manualChunks,
    // },
  },
  plugins: [workerChunkPlugin()],
});