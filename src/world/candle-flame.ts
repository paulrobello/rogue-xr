import * as THREE from 'three';

const flameVertex = `
  varying vec2 flameUv;
  varying float wickPhase;
  uniform float uPhase;
  #ifdef WICK_BATCH
    attribute vec2 corner;
    attribute vec4 params;
  #endif
  void main() {
    #ifdef WICK_BATCH
      flameUv = vec2(.5 + .5 * corner.x, corner.y);
      wickPhase = params.x;
      vec4 center = modelViewMatrix * vec4(position, 1.);
      vec2 offset = vec2(.5 * corner.x * params.y, corner.y * params.z);
    #else
      flameUv = uv;
      wickPhase = uPhase;
      vec4 center = modelViewMatrix * vec4(0., 0., 0., 1.);
      vec2 offset = position.xy;
    #endif
    vec3 up = normalize(modelViewMatrix[1].xyz);
    vec3 side = cross(up, -center.xyz);
    side = dot(side, side) > 0.00001 ? normalize(side) : vec3(1., 0., 0.);
    center.xyz += side * offset.x * length(modelMatrix[0].xyz)
                + up * offset.y * length(modelMatrix[1].xyz);
    gl_Position = projectionMatrix * center;
  }
`;
const flameFragment = `
  uniform float uTime, uMotion;
  varying float wickPhase;
  varying vec2 flameUv;
  void main() {
    float phase = uTime * 3.4 + wickPhase;
    float height = 0.89 + 0.025 * uMotion * sin(phase * 1.73);
    float h = max(0., (flameUv.y - 0.025) / height);
    float bend = uMotion * h * h * (0.19 * sin(phase) + 0.10 * sin(2.17 * phase - 3.8 * h));
    float x = abs(flameUv.x - 0.5 - bend);
    float radius = 0.39 * smoothstep(-0.07, 0.22, h) * pow(max(0., 1. - h), 0.83);
    float aa = clamp(fwidth(x), 0.009, 0.065);
    float edge = x - radius;
    float body = 1. - smoothstep(-aa, aa, edge);
    float halo = 1. - smoothstep(-0.015, 0.10, edge);
    float alpha = (0.88 * body + 0.12 * halo) * smoothstep(0., 0.06, flameUv.y)
                  * (1. - smoothstep(0.96, 1.02, h));
    if (alpha < 0.01) discard;
    float coreRadius = radius * 0.77 * (1. - smoothstep(0.24, 0.79, h));
    float core = (1. - smoothstep(coreRadius * 0.65, coreRadius + aa, x))
                 * (1. - smoothstep(0.66, 0.8, h));
    vec3 color = mix(vec3(1., 0.14 + 0.15 * body, 0.012), vec3(1., 0.88, 0.16), core);
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

export function candleMaterial(
  phase: number,
  reducedMotion: boolean,
  batch = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: flameVertex,
    fragmentShader: flameFragment,
    defines: batch ? { WICK_BATCH: 1 } : {},
    uniforms: {
      uTime: { value: 0 },
      uPhase: { value: phase },
      uMotion: { value: reducedMotion ? 0 : 1 },
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}
