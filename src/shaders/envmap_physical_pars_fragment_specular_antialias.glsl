#ifdef USE_ENVMAP
  vec3 getIBLIrradiance( const in vec3 normal ) {
    #ifdef ENVMAP_TYPE_CUBE_UV
      vec3 worldNormal = inverseTransformDirection( normal, viewMatrix );
      vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
      return PI * envMapColor.rgb * envMapIntensity;
    #else
      return vec3( 0.0 );
    #endif
  }

  vec3 getIBLRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in float geometryRoughness ) {
    #ifdef ENVMAP_TYPE_CUBE_UV
      vec3 reflectVec = reflect( - viewDir, normal );
      float dotNV = saturate( dot( normal, viewDir ) ); // View-normal angle (0 to 1)

      // Your current angle-based control
      float blurStart = 0.3;  // angle-start
      float blurFull = 0.0;   // angle-full
      float maxMipBias = 2.0;
      float grazingFactor = smoothstep(blurStart, blurFull, dotNV); // 0 at blurStart, 1 at blurFull
      float mipBias = grazingFactor * maxMipBias; // Max bias at grazing
      float adjustedRoughness = clamp(roughness + mipBias * roughness + geometryRoughness * 0.5, 0.0, 1.0);

      reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
      reflectVec = inverseTransformDirection( reflectVec, viewMatrix );

      // Sample environment map
      vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, adjustedRoughness );

      // Valve-inspired geometric radiance adjustment
      vec3 normalDdx = dFdx( normal ); // Partial derivatives of fragment normal
      vec3 normalDdy = dFdy( normal );
      float geoFactor = pow( saturate( max( dot( normalDdx, normalDdx ), dot( normalDdy, normalDdy ) ) ), 0.333 ); // Curvature estimate
      float radianceGeoLimit = mix(0.5, 1.0, geoFactor); // Reduce radiance on high curvature (e.g., edges)

      // Combine with angle-based limit
      float radianceAngleLimit = mix(2.0, 0.1, grazingFactor); // Your original angle-based limit
      float radianceLimit = radianceAngleLimit * radianceGeoLimit; // Multiply for combined effect

      return envMapColor.rgb * envMapIntensity * radianceLimit;
    #else
      return vec3( 0.0 );
    #endif
  }

  #ifdef USE_ANISOTROPY
    vec3 getIBLAnisotropyRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in vec3 bitangent, const in float anisotropy, const in float geometryRoughness ) {
      #ifdef ENVMAP_TYPE_CUBE_UV
        vec3 bentNormal = cross( bitangent, viewDir );
        bentNormal = normalize( cross( bentNormal, bitangent ) );
        bentNormal = normalize( mix( bentNormal, normal, pow2( pow2( 1.0 - anisotropy * ( 1.0 - roughness ) ) ) ) );
        return getIBLRadiance( viewDir, bentNormal, roughness, geometryRoughness );
      #else
        return vec3( 0.0 );
      #endif
    }
  #endif
#endif