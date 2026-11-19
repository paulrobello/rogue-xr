"""Repair the former floor-inlay shadows without altering other lightmap blocks.

Run: uv run --with numpy --with pillow --with zstandard python \
  scripts/assets/repair-corridor-lightmap.py BASELINE.ktx2 OUTPUT.ktx2 [guardian-vault]
The baseline is the original room lightmap, before this repair. The floor UV
mapping is read from the existing runtime GLB; geometry and UVs are not modified.
"""
from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
import zstandard as zstd

ROOT = Path(__file__).resolve().parents[2]
KTX = Path.home() / '.local/opt/ktx-software-4.4.2/bin/ktx'


def floor_mapping(room: str):
    glb = ROOT / f"public/assets/rooms/{room}/{room}.glb"
    data = glb.read_bytes()
    size = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20+size]); binary = data[28+size:]
    mesh = next(m for m in gltf['meshes'] if m['name'] == room)
    prim = next(p for p in mesh['primitives'] if gltf['materials'][p['material']]['name'] == f'{room}_stone-floor')
    def read(index, width):
        a = gltf['accessors'][index]; v = gltf['bufferViews'][a['bufferView']]
        assert a['componentType'] == 5126 and 'byteStride' not in v
        return np.frombuffer(binary, dtype='<f4', count=a['count']*width, offset=v.get('byteOffset',0)+a.get('byteOffset',0)).reshape(-1,width)
    pos = read(prim['attributes']['POSITION'],3); uv = read(prim['attributes']['TEXCOORD_1'],2)
    if room == 'corridor':
        assert len(pos)==4 and np.allclose(pos[:,1],0)
    else:
        select = (np.isclose(pos[:,1],0) & (np.isclose(pos[:,0],-.04) | np.isclose(pos[:,0],2.04)) & (np.isclose(pos[:,2],-6) | np.isclose(pos[:,2],5.8)))
        pos, uv = pos[select], uv[select]
    x = np.polyfit(pos[:,0],uv[:,0],1); z = np.polyfit(pos[:,2],uv[:,1],1)
    tolerance = 1e-8 if room == 'corridor' else 1e-6
    assert np.allclose(np.polyval(x,pos[:,0]),uv[:,0],atol=tolerance) and np.allclose(np.polyval(z,pos[:,2]),uv[:,1],atol=tolerance)
    return x,z


def levels(data):
    assert data[:12] == b'\xabKTX 20\xbb\r\n\x1a\n'
    w,h,depth,layers,faces,count,compression = struct.unpack_from('<7I',data,20)
    assert (w,h,depth,layers,faces,count,compression)==(2048,2048,0,0,1,12,2)
    return [struct.unpack_from('<QQQ',data,80+24*i) for i in range(count)]


def repair(source: Path, output: Path, room: str = "corridor"):
    assert room in ("corridor", "guardian-vault")
    x,z=floor_mapping(room); original=source.read_bytes(); original_levels=levels(original)
    masks=[]
    with tempfile.TemporaryDirectory() as tmp:
        tmp=Path(tmp); png=tmp/'source.png'; changed=tmp/'changed.png'; encoded=tmp/'encoded.ktx2'
        subprocess.run([str(KTX),'extract','--transcode','rgba8',str(source),str(png)],check=True)
        pixels=np.array(Image.open(png).convert('RGB')); mask=np.zeros(pixels.shape[:2],dtype=bool)
        xp=lambda v: int(round(np.polyval(x,v)*2048)); yp=lambda v: int(round(np.polyval(z,v)*2048))
        # Eight texels span the baked strip and its filter fringe. Endpoints and
        # samples remain inside the large, uninterrupted floor island.
        def vertical(cx, y0, y1):
            a,b=cx-7,cx+7
            for px in range(a+1,b):
                t=(px-a)/(b-a); pixels[y0:y1+1,px]=np.rint((1-t)*pixels[y0:y1+1,a].astype(float)+t*pixels[y0:y1+1,b]).astype('uint8')
            mask[y0:y1+1,a+1:b]=True
        def horizontal(cy, x0, x1):
            a,b=cy-7,cy+7
            for py in range(a+1,b):
                t=(py-a)/(b-a); pixels[py,x0:x1+1]=np.rint((1-t)*pixels[a,x0:x1+1].astype(float)+t*pixels[b,x0:x1+1]).astype('uint8')
            mask[a+1:b,x0:x1+1]=True
        if room == 'corridor':
            for world_x in (-.5,.5): vertical(xp(world_x),yp(-3.92)-4,yp(3.92)+4)
            for world_z in (-2,0,2): horizontal(yp(world_z),xp(-.5)-7,xp(.5)+7)
        else:
            for world_x in (.35,1.65): vertical(xp(world_x),yp(-.95)-4,yp(5.16)+4)
            horizontal(yp(5.13),xp(.29)-7,xp(1.71)+7)
        Image.fromarray(pixels).save(changed)
        subprocess.run([str(KTX),'create','--format','R8G8B8_SRGB','--assign-tf','srgb','--encode','uastc','--uastc-quality','2','--zstd','18','--generate-mipmap',str(changed),str(encoded)],check=True)
        new=encoded.read_bytes(); new_levels=levels(new)
        # UASTC stores independent 4x4 blocks. Keep the original bytes for all
        # blocks not intersecting the repair, including every wall island.
        header=bytearray(original[:min(o for o,_,_ in original_levels)])
        payload=bytearray(header); decoder=zstd.ZstdDecompressor(); compressor=zstd.ZstdCompressor(level=18)
        for level in reversed(range(len(original_levels))):
            oldoff,oldlen,rawlen=original_levels[level]; newoff,newlen,newraw=new_levels[level]
            old=bytearray(decoder.decompress(original[oldoff:oldoff+oldlen],max_output_size=rawlen))
            replacement=decoder.decompress(new[newoff:newoff+newlen],max_output_size=newraw)
            w=max(1,2048>>level); blocks=max(1,math.ceil(w/4)); touched=set()
            ys,xs=np.nonzero(mask)
            for by,bx in zip((ys>>level)//4,(xs>>level)//4): touched.add((int(by),int(bx)))
            for by,bx in touched:
                offset=(by*blocks+bx)*16; old[offset:offset+16]=replacement[offset:offset+16]
            packed=compressor.compress(old); off=len(payload); payload.extend(packed)
            struct.pack_into('<QQQ',payload,80+24*level,off,len(packed),rawlen)
            masks.append((level,len(touched),blocks*blocks))
        output.write_bytes(payload)
        print('floor_uv',x.tolist(),z.tolist(),'repair_pixels',int(mask.sum()),'blocks',list(reversed(masks)))


if __name__ == '__main__':
    repair(Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3] if len(sys.argv) > 3 else "corridor")
