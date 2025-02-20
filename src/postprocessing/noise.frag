uniform float intensity;
uniform float speed;
uniform float mean;
uniform float variance;

float gaussian(float z, float u, float o) {
	return (1.0 / (o * sqrt(2.0 * 3.1415))) * exp(-(((z - u) * (z - u)) / (2.0 * (o * o))));
}

// Improved hash function with coordinate scrambling
float hash(vec2 p) {
	p = mat2(127.1, 311.7, 269.5, 183.3) * p;
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec4 mainImage(const in vec4 inputColor, const in vec2 uv, const in GData gData) {
	float t = time * speed;

	// Coordinate scrambling with temporal influence
	vec2 st = uv * mat2(0.995004165, 0.099833417, -0.099833417, 0.995004165);

	// Multi-frequency noise sampling
	float noise = hash(st);
	noise += hash(st * 2.732);
	noise += hash(st * 7.158);
	noise = fract(noise * 12345.6789 + t);

	// Temporal modulation that preserves spatial stability
	noise = gaussian(noise, mean, variance * variance);

	vec3 result = mix(inputColor.rgb, inputColor.rgb + noise, intensity);

	return vec4(result, inputColor.a);
}