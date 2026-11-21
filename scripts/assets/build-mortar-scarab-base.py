"""Build the unrigged Mortar Scarab model review candidate in Blender."""
import bpy, math, os, json, hashlib
from mathutils import Vector
from math import sin, cos, pi, sqrt

OUT = os.environ['SCARAB_OUT']
os.makedirs(OUT, exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)

def material(name, color, metallic=0, roughness=.6, emission=0):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1); p.inputs['Metallic'].default_value=metallic; p.inputs['Roughness'].default_value=roughness
    if emission:
        p.inputs['Emission Color'].default_value=(*color,1); p.inputs['Emission Strength'].default_value=emission
    return m
stone=material('limestone',(.20,.155,.125),0,.86)
brass=material('aged-brass',(.48,.27,.075),.72,.38)
iron=material('dark-iron',(.085,.075,.065),.76,.56)
amber=material('amber-core',(.8,.12,.005),.15,.3,.45)

def finish(o,name,mat):
    o.name=name; o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth=True
    return o

def sphere(name,loc,scale,mat,seg=24,rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=rings,location=loc); o=bpy.context.object; o.scale=scale; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); return finish(o,name,mat)

def segment(name,a,b,r1,r2,mat,vertices=10):
    a,b=Vector(a),Vector(b); d=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=r1,radius2=r2,depth=d.length,location=(a+b)/2)
    o=bpy.context.object; o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); finish(o,name,mat)
    bevel=o.modifiers.new('edge wear','BEVEL'); bevel.width=.008; bevel.segments=2
    o.modifiers.new('weighted normals','WEIGHTED_NORMAL'); return o

def torus(name,loc,major,minor,mat,rot=(0,0,0)):
    bpy.ops.mesh.primitive_torus_add(major_segments=32,minor_segments=8,location=loc,major_radius=major,minor_radius=minor,rotation=rot); return finish(bpy.context.object,name,mat)

def parent_new(root, before):
    for obj in set(bpy.context.scene.objects)-before-{root}:
        world=obj.matrix_world.copy(); obj.parent=root; obj.matrix_world=world

def pivot(name, loc):
    obj=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(obj); obj.location=loc
    bpy.context.view_layer.update(); return obj

def plate(n, side):
    name='shell-lamella-%02d-%s'%(n,'left' if side<0 else 'right')
    # Fore plates sit above the rear edges, leaving a physical recess between layers.
    y0=-.37+n*.215; y1=y0+.255
    root=pivot(name+'-pivot',(side*.06,y1,.39)); before=set(bpy.context.scene.objects)
    verts=[]; faces=[]; nx=8; ny=5
    def surface(u,v):
        y=y0+(y1-y0)*v-.045*u*u
        taper=(.81+.19*((y+.37)/.69))*sqrt(max(.35,1-(y/.70)**2))
        angle=(.035+1.30*u)*side
        lift=.031*n
        return (taper*.395*sin(angle),y,.29+taper*.285*cos(angle)+lift+.0025*sin(u*13+n*3+side))
    for j in range(ny+1):
        for i in range(nx+1):
            u=i/nx; v=j/ny
            x,y,z=surface(u,v)
            # Broken silhouette at the outer edge, unique to each panel.
            if i==nx: y+=.008*sin((n*2+side)*2+j*2.2)
            verts.append((x,y,z))
    for j in range(ny):
        for i in range(nx):
            a=j*(nx+1)+i; face=(a,a+1,a+nx+2,a+nx+1); faces.append(face if side>0 else tuple(reversed(face)))
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(verts,[],faces); mesh.update(); obj=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(obj); finish(obj,name,stone)
    mod=obj.modifiers.new('thick stone edge','SOLIDIFY'); mod.thickness=.045; mod.offset=-1
    mod=obj.modifiers.new('worn corners','BEVEL'); mod.width=.008; mod.segments=2
    obj.modifiers.new('weighted normals','WEIGHTED_NORMAL')
    # Short non-repeating cuts and chipped outer edges, attached to this plate.
    u0=.25+.09*((n+(side>0))%3); v0=.18+.11*((n*2+(side>0))%4)
    pts=[]
    for k in range(4):
        x,y,z=surface(u0+(.04+.012*((n+(side>0))%3))*k,v0+.04*sin(k*(1.5+n*.3)+side)); pts.append((x,y,z+.003))
    for k in range(3): segment(name+'-fissure-'+str(k),pts[k],pts[k+1],.0017,.0013,iron,6)
    x,y,z=surface(.83,.72); sphere(name+'-rivet',(x,y,z+.008),(.012,.012,.007),brass,12,6)
    parent_new(root,before)

sphere('body-armored-chassis',(0,0,.28),(.29,.38,.17),iron)
for n in range(3):
    for side in (-1,1): plate(n,side)
# Frontal vent assembly faces +Y, with deep contained core and protective jaws.
sphere('head-vent-housing',(0,.365,.31),(.155,.093,.14),iron)
# Dark raised rim frames an amber core recessed behind its front face.
torus('head-vent-outer-collar',(0,.455,.32),.105,.021,iron,(pi/2,0,0))
torus('head-core-brass-bezel',(0,.456,.32),.084,.009,brass,(pi/2,0,0))
torus('head-core-inner-bezel',(0,.458,.32),.047,.006,iron,(pi/2,0,0))
sphere('head-amber-core',(0,.445,.32),(.068,.016,.068),amber)
for side in (-1,1):
    segment('head-mandible-%s'%side,(side*.14,.43,.36),(side*.11,.47,.20),.029,.014,iron)
    for n in range(3):
        x=side*(.024+n*.023)
        segment('head-vent-slat-%s-%s'%(side,n),(x,.466,.275),(x,.466,.365),.004,.004,brass,8)
# Each independent leg has substantial articulated upper and lower segments.
for side in (-1,1):
    label='left' if side<0 else 'right'
    for i,y in enumerate((.25,0,-.25)):
        y += side*(.07 if i==0 else -.055 if i==2 else .015)
        hip=(side*.255,y,.27); root=pivot('leg-%s-%d-pivot'%(label,i),hip); before=set(bpy.context.scene.objects)
        knee=(side*(.405+(.02 if i==1 else 0)+(.055 if side<0 else 0)), y+(.10 if i==0 else -.08 if i==2 else 0),.22)
        foot=(side*(.48+(.02 if i==1 else 0)+(.14 if side<0 else 0)),y+(.15 if i==0 else -.13 if i==2 else 0),.016)
        mid=(side*(.46+(.02 if i==1 else 0)+(.12 if side<0 else 0)),foot[1],.027)
        pre='leg-%s-%d-'%(label,i)
        segment(pre+'upper',hip,knee,.052,.043,iron)
        segment(pre+'upper-armor',tuple(Vector(hip).lerp(Vector(knee),.2)),tuple(Vector(hip).lerp(Vector(knee),.84)),.046,.039,iron)
        segment(pre+'shin',knee,mid,.038,.028,iron)
        segment(pre+'shin-armor',tuple(Vector(knee).lerp(Vector(mid),.14)),tuple(Vector(knee).lerp(Vector(mid),.84)),.036,.027,iron)
        bpy.ops.mesh.primitive_cube_add(size=1,location=foot)
        pad=bpy.context.object; pad.scale=(.064,.07,.032); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); finish(pad,pre+'foot',brass)
        bevel=pad.modifiers.new('foot corners','BEVEL'); bevel.width=.006; bevel.segments=2
        pad.modifiers.new('weighted normals','WEIGHTED_NORMAL')
        sphere(pre+'knee',knee,(.054,.054,.054),iron,16,8)
        segment(pre+'knee-cap',(knee[0]+side*.045,knee[1],knee[2]),(knee[0]+side*.059,knee[1],knee[2]),.038,.038,brass,20)
        sphere(pre+'hip',hip,(.043,.043,.043),iron,16,8)
        segment(pre+'hip-collar',(hip[0]+side*.041,hip[1],hip[2]),(hip[0]+side*.053,hip[1],hip[2]),.031,.031,brass,16)
        parent_new(root,before)
for name,loc in [('socket-hit',(0,.1,.56)),('socket-eye',(0,.49,.32)),('socket-weapon',(.48,.40,.08))]:
    o=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(o); o.location=loc
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'mortar-scarab-base.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,'mortar-scarab-base.glb'),export_format='GLB',export_animations=False)
# Reimport the actual delivered file for metrics and the review renders.
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=os.path.join(OUT,'mortar-scarab-base.glb'))
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
points=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box]
mins=[min(p[i] for p in points) for i in range(3)]; maxs=[max(p[i] for p in points) for i in range(3)]
triangles=sum(len(o.data.loop_triangles) for o in meshes for _ in [o.data.calc_loop_triangles()])
report={'bounds_blender_m':{'min':mins,'max':maxs},'triangle_count':triangles,'mesh_count':len(meshes),'materials':sorted({m.name for o in meshes for m in o.data.materials if m}), 'objects':sorted(o.name for o in bpy.context.scene.objects), 'stage':'base model candidate; owner review pending; no rig, animation, runtime or production approval'}
with open(os.path.join(OUT,'reimport-report.json'),'w') as f: json.dump(report,f,indent=2)
# Neutral studio floor and lights exist only in review scene, not exported asset.
world=bpy.context.scene.world; world.color=(.14,.14,.14)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002)); floor=bpy.context.object; floor.name='review-floor'; floor.data.materials.append(material('review-floor',(.095,.083,.072),0,.9))
def light(name,loc,power,size):
    data=bpy.data.lights.new(name,'AREA'); data.energy=power; data.shape='DISK'; data.size=size; obj=bpy.data.objects.new(name,data); bpy.context.collection.objects.link(obj); obj.location=loc; obj.rotation_euler=(Vector((0,0,.25))-obj.location).to_track_quat('-Z','Y').to_euler()
light('key',(1.5,2.5,3),85,2.5); light('fill',(-2,-1,1.8),55,2); light('rim',(0,-2,2.5),65,1.5)
scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE'
scene.eevee.taa_render_samples=16
scene.render.resolution_x=800; scene.render.resolution_y=640; scene.render.resolution_percentage=100
scene.world.color=(.1,.1,.1); scene.view_settings.view_transform='AgX'
camdata=bpy.data.cameras.new('review-camera'); camera=bpy.data.objects.new('review-camera',camdata); bpy.context.collection.objects.link(camera); scene.camera=camera; camdata.type='ORTHO'; camdata.ortho_scale=1.8
for name,loc in [('three-quarter',(1.05,1.45,1.8)),('side',(2.8,.04,.85)),('raised',(1.2,1.8,2.6))]:
    camera.location=loc; camera.rotation_euler=(Vector((0,0,.28))-camera.location).to_track_quat('-Z','Y').to_euler(); scene.render.filepath=os.path.join(OUT,'review-'+name+'.png'); bpy.ops.render.render(write_still=True)

# Bind review evidence to the exact delivered artifacts.
def digest(path):
    with open(path,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
report['sha256']={
    'generator':digest(os.environ['SCARAB_GENERATOR']),
    'concept':digest(os.environ['SCARAB_CONCEPT']),
    'blend':digest(os.path.join(OUT,'mortar-scarab-base.blend')),
    'glb':digest(os.path.join(OUT,'mortar-scarab-base.glb')),
    **{'review-'+n:digest(os.path.join(OUT,'review-'+n+'.png')) for n in ('three-quarter','side','raised')}
}
report['revision']='Revision of GLB 8caf62ff independently scored 69/100: shortened stepped lamellae, grouped plate details, exposed joints, recessed vent and staggered legs.'
report['review']={'base_model':'owner review pending', 'runtime':'not promoted; no rig or animation authored'}
report['render_engine']='Blender EEVEE; three views rendered from the exact reimported static GLB'
report['foot_bottoms_m']={o.name:min((o.matrix_world@Vector(c)).z for c in o.bound_box) for o in meshes if o.name.endswith('-foot')}
report['parent_roots']={o.name:o.parent.name if o.parent else None for o in meshes if o.name.startswith('leg-') or o.name.startswith('shell-lamella-')}
assert triangles <= 25000 and len(report['materials']) <= 4
assert .55 <= maxs[2]-mins[2] <= .64
assert len(report['foot_bottoms_m'])==6 and all(abs(z)<=.002 for z in report['foot_bottoms_m'].values())
with open(os.path.join(OUT,'reimport-report.json'),'w') as f: json.dump(report,f,indent=2)
