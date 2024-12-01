renderer.debug.onShaderError = function (gl, _program, vs, fs) {
   const parseForErrors = function (gl, shader, name) {
      const errors = gl.getShaderInfoLog(shader).trim();
      const prefix = "Errors in " + name + ":" + "\n\n" + errors;

      if (errors !== "") {
         const code = gl.getShaderSource(shader).replaceAll("\t", "  ");
         const lines = code.split("\n");
         var linedCode = "";
         var i = 1;
         for (var line of lines) {
            // linedCode += (i < 10 ? " " : "") + i + ":\t\t" + line + "\n";
            linedCode += line + "\n";
            i++;
         }

         console.error(prefix + "\n" + linedCode);
      }
   };

   parseForErrors(gl, vs, "Vertex Shader");
   parseForErrors(gl, fs, "Fragment Shader");
};


{
   const loader = new GLTFLoader();
   loader.load(helmetModelUrl, async function (gltf) {
      const model = gltf.scene;
      model.scale.set(1, 1, 1);

      // Improve texture quality for all materials in the model
      model.traverse((child) => {
         // console.log(child.material)
         if (child.material) {
            child.material.needsUpdate = true
            child.material.onBeforeCompile = (shader) => {
               // Inject code into the shader
               shader.fragmentShader = shader.fragmentShader.replace(
                  `vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;`,
                  `vec3 totalSpecular = a reflectedLight.directSpecular + reflectedLight.indirectSpecular;`,
               );
               console.log(shader.fragmentShader)

               // console.log(shader)
            };
         }

         if (child.isMesh) {
            child.receiveShadow = false;
            // Helper function to apply optimal texture settings
            const optimizeTexture = (texture) => {
               if (texture) {
                  // texture.minFilter = THREE.LinearFilter;
                  texture.minFilter = THREE.LinearMipmapLinearFilter;
                  texture.magFilter = THREE.LinearFilter;
                  texture.anisotropy = renderer.capabilities
                     .getMaxAnisotropy();
                  // texture.anisotropy = false;
                  texture.generateMipmaps = true;
               }
            };

            // Apply to all available texture maps
            optimizeTexture(child.material.map); // Base color/diffuse map
            optimizeTexture(child.material.normalMap); // Normal map
            optimizeTexture(child.material.roughnessMap); // Roughness map
            optimizeTexture(child.material.metalnessMap); // Metalness map
         }
      });

      // wait until the model can be added to the scene without blocking due to shader compilation
      await renderer.compileAsync(model, camera, scene);

      mixer = new THREE.AnimationMixer(model);
      const action = mixer.clipAction(gltf.animations[0]);
      // action.play();

      scene.add(model);
      requestAnimationFrame(render);
   });
}