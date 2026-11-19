import json,struct,sys
import numpy as np

def load(p):
 d=open(p,'rb').read(); n=struct.unpack_from('<I',d,12)[0];return json.loads(d[20:20+n]),d[28+n:]
def ar(g,b,i):
 a=g['accessors'][i];v=g['bufferViews'][a['bufferView']]; dt={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']];w={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']];return np.frombuffer(b,dtype=dt,count=a['count']*w,offset=v.get('byteOffset',0)+a.get('byteOffset',0)).reshape(-1,w)
def scene(p):
 g,b=load(p);nodes=g['nodes'];out={}
 def visit(i):
  n=nodes[i]; item={'transform':{k:n[k] for k in ('translation','rotation','scale','matrix') if k in n},'children':sorted(nodes[j].get('name') for j in n.get('children',[])),'primitives':[]}
  if 'mesh' in n:
   for prim in g['meshes'][n['mesh']]['primitives']:
    idx=ar(g,b,prim['indices']).reshape(-1,3).astype('int64'); idx=np.sort(idx,axis=1); idx=idx[np.lexsort((idx[:,2],idx[:,1],idx[:,0]))]
    item['primitives'].append((g['materials'][prim['material']]['name'],{k:ar(g,b,v).copy() for k,v in prim['attributes'].items()},idx))
  out[n['name']]=item
  for c in n.get('children',[]):visit(c)
 roots=('DoorSingle','DoorDouble','DoorArched','Curtain','Bookcase','Candelabrum','WallClock','ClockworkArmor','FramedPainting')
 for i,n in enumerate(nodes):
  if n.get('name') in roots:visit(i)
 return out
a=scene(sys.argv[1]);b=scene(sys.argv[2]);assert a.keys()==b.keys()
for n in a:
 x,y=a[n],b[n];assert x['transform']==y['transform'] and x['children']==y['children'] and len(x['primitives'])==len(y['primitives']),n
 for (xm,xa,xi),(ym,ya,yi) in zip(x['primitives'],y['primitives']):
  assert xm==ym and xa.keys()==ya.keys() and np.array_equal(xi,yi),n
  for k in xa: assert xa[k].shape==ya[k].shape and np.allclose(xa[k],ya[k],rtol=0,atol=1e-6), (n,k)
print('PASS',len(a),'non-dining nodes; transforms, material names, triangle vertex sets and attributes match within 1e-6')
