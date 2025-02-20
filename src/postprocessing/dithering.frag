uniform float intensity;

float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 noiseDithering(vec3 color, vec2 fragCoord) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float noise = rand(fragCoord) - 0.5;
    float ditheredLuma = luma + noise * intensity;
    return color * (ditheredLuma / luma);
}

vec4 mainImage(const in vec4 inputColor, const in vec2 uv, const in GData gData) {
    vec3 ditheredColor = noiseDithering(inputColor.rgb, uv); 
    return vec4(ditheredColor, inputColor.a);
}