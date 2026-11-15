# Lightmap workflow proof (room-proof fixture)

Date: 2026-11-15. Pipeline: `scripts/assets/build_room_proof.py` on MiniMac (Blender 5.3.0, Cycles on Apple M4 Metal).

## Bake

| Field | Value |
| --- | --- |
| Lightmap | 1024², 512 samples, DIFFUSE direct + indirect, colour off, OIDN (HDR, Accurate, High) |
| Bake time | 15.4 s warm. The first Metal bake on a host took 190 s, mostly kernel compile |
| Texel density | 66.5 px/m mean, 60.7 min |
| Coverage | 81.9 % of texels |
| Encoding | srgb-scaled, scale 7.582313 (99.9th percentile), 0.1 % of texels clipped |

## three.js against the Blender reference

`?view=lightmap-proof` (800×600, NoToneMapping, lightmap only, intensity = π × scale) compared with
`room-proof.reference-diffuse.png` (Cycles, Standard view transform, Specular IOR Level 0, same camera).
Ratio is mean three.js luminance over mean Blender luminance.

| Region | Ratio |
| --- | --- |
| Whole frame | 0.994 (RMSE 0.0092) |
| Back wall | 1.006 |
| Ceiling | 1.015 |
| Left wall | 1.013 |
| Pillar | 1.024 |
| Floor sun patch | 0.974 |
| Table top | 0.942 (RMSE 0.0437) |

Against the beauty reference (specular on), the sun patch drops to 0.565 and the table to 0.684. A
diffuse lightmap carries no specular, so glossy and metal surfaces need probes or dynamic lights.

Dark regions (p05 texel about 18/255) show no visible banding on desktop. Headset banding is
unchecked. Screenshot: `p4-lightmap-proof-threejs.jpg`.
