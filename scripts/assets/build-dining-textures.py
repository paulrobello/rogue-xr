"""Derive compact dining PBR maps from licensed kit walnut and a woven fabric."""
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[2]
out = root / 'assets-source/props/interior-furnishings/textures'
out.mkdir(parents=True, exist_ok=True)
for name in ('basecolor', 'normal', 'orm'):
    im = Image.open(root / f'public/assets/materials/walnut/walnut.{name}.png').convert('RGB')
    im.resize((1024, 1024), Image.Resampling.LANCZOS).save(out / f'dining-walnut.{name}.png', optimize=True)
size = 512
y, x = np.mgrid[0:size, 0:size]
rng = np.random.default_rng(3014)
# Crossing threads and low-amplitude nap read as cloth without a baked light direction.
weave = 2.6*np.cos(2*np.pi*x/8) + 2.0*np.cos(2*np.pi*y/8) + rng.normal(0, .7, (size,size))
color = np.stack([np.clip(75+weave*1.5,0,255),np.clip(18+weave*.45,0,255),np.clip(31+weave*.7,0,255)],axis=-1).astype('uint8')
Image.fromarray(color).save(out/'dining-claret.basecolor.png',optimize=True)
nx = 128+2.2*np.sin(2*np.pi*x/8); ny = 128+2.2*np.sin(2*np.pi*y/8)
normal=np.stack([nx,ny,np.full_like(nx,255)],axis=-1).astype('uint8')
Image.fromarray(normal).save(out/'dining-claret.normal.png',optimize=True)
orm=np.stack([np.full_like(x,255),np.clip(210+weave,0,255),np.zeros_like(x)],axis=-1).astype('uint8')
Image.fromarray(orm).save(out/'dining-claret.orm.png',optimize=True)
