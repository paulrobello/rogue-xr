"""Build the Foundry enemies from the approved concept sheets.

Blender +Y faces the player (glTF -Z); root motion belongs to gameplay.
Run: blender -b -t 1 --python-exit-code 1 -P scripts/assets/build-foundry-enemies.py -- ID OUTPUT
OUTPUT is a staging directory; copy verified outputs into the matching project paths.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('hound', REPO / 'scripts/assets/build-spring-hound.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

IDS = ('glasswing-scrivener', 'furnace-mite', 'null-crown-auditor')
ID, OUT = sys.argv[sys.argv.index('--') + 1:][:2]
assert ID in IDS
OUT = Path(OUT).resolve()
OUT.mkdir(parents=True, exist_ok=True)
CONCEPT = {'glasswing-scrivener':'glasswing-scrivener', 'furnace-mite':'twin-furnace-mites', 'null-crown-auditor':'null-crown-auditor'}[ID]
BONES = [('root', None, (0,0,0), (0,0,.2)), ('body','root',(0,0,.65),(0,0,.85))]
if ID == 'glasswing-scrivener':
    for s,n in [(-1,'L'),(1,'R')]:
        BONES += [(f'wing.{n}','body',(s*.19,-.12,.92),(s*.65,-.12,1.12)),
                  (f'nib.{n}','body',(s*.22,.28,.72),(s*.45,.67,.38))]
        for i,y in enumerate((-.30,0,.25)):
            BONES += [(f'leg{i}.{n}','body',(s*.24,y,.66),(s*.55,y,.30))]
elif ID == 'furnace-mite':
    for s,n in [(-1,'L'),(1,'R')]:
        BONES += [(f'shutter.{n}','body',(s*.36,.42,.63),(s*.36,.42,.9))]
        for i,y in enumerate((-.22,.24)):
            BONES += [(f'leg{i}.{n}','body',(s*.37,y,.45),(s*.63,y,.15))]
else:
    BONES += [('stamp','body',(-.36,0,.88),(-.78,.06,.55)),('abacus','body',(.36,0,.88),(.78,.06,.66)),
              ('cover.L','body',(-.04,.10,.72),(-.34,.10,.72)),('cover.R','body',(.04,.10,.72),(.34,.10,.72))]
    for i in range(3): BONES.append((f'bead.{i}','abacus',(.74,.1,.54+i*.12),(.79,.1,.54+i*.12)))
h.BONES = BONES
h.BONE_NAMES = [b[0] for b in BONES]
P = h.Parts(bmesh, 'low')
EXTRA = h.Parts(bmesh, 'low') if ID=='furnace-mite' else None
# Material indices: warm brass, dark gunmetal, jewel red, amber glow, ivory/variant.
BRASS, DARK, RUBY, GLOW, IVORY, BLUE, WING_RED, WING_BLUE = range(8)
MATS = ['foundry-brass','foundry-dark','foundry-glow', 'foundry-glass' if ID=='glasswing-scrivener' else 'foundry-mark']

def rod(a,b,r,mat,bone,r2=None):
    r2 = r if r2 is None else r2
    P.loft([(a,r,r,r,2),(b,r2,r2,r2,2)],mat,bone,sub=1,n=8,bevel=.15)

def ellipsoid(c,scale,mat,bone):
    x,y,z=c; a,b,d=scale
    P.loft([((x,y,z-d*.88),a*.48,b*.48,b*.48,2),((x,y,z-d*.5),a*.88,b*.88,b*.88,2),
            ((x,y,z),a,b,b,2),((x,y,z+d*.5),a*.88,b*.88,b*.88,2),((x,y,z+d*.88),a*.48,b*.48,b*.48,2)],mat,bone,ref=(1,0,0),sub=1,n=12)

def plate(points,depth,mat,bone):
    # front/back polygon surfaces with closed edges
    P.surface([[Vector((x,y-depth/2,z)) for x,y,z in points], [Vector((x,y+depth/2,z)) for x,y,z in points]], [bone,bone],mat,False,cap_depth=(0,0))

def border(points,mat,bone,r=.018):
    for a,b in zip(points,points[1:]+points[:1]): rod(a,b,r,mat,bone)

def gem(c,r,bone):
    P.disc(c,(0,1,0),r,.025,BRASS,bone,n=12)
    P.disc((c[0],c[1]+.018,c[2]),(0,1,0),r*.67,.025,RUBY,bone,n=12)

def build_scrivener():
    ellipsoid((0,-.06,.72),(.32,.43,.24),DARK,'body')
    ellipsoid((0,-.10,.84),(.30,.37,.14),BRASS,'body')
    ellipsoid((0,.38,.83),(.19,.20,.20),DARK,'body')
    ellipsoid((0,.43,.90),(.17,.18,.12),BRASS,'body')
    P.disc((0,.556,.84),(0,1,0),.11,.045,DARK,'body')
    P.disc((0,.585,.84),(0,1,0),.075,.035,GLOW,'body')
    for s in (-1,1):
        rod((s*.03,.58,.91),(s*.14,.53,.96),.018,BRASS,'body')
    P.disc((0,.39,.67),(0,1,0),.13,.04,BRASS,'body')
    P.disc((0,.42,.67),(0,1,0),.087,.04,GLOW,'body')
    for y in (-.24,-.10,.04):
        P.ring((0,y,.73),(0,1,0),.29,.20,.018,.013,BRASS,'body',n=20)
    for s,n in [(-1,'L'),(1,'R')]:
        wing=f'wing.{n}'; nib=f'nib.{n}'
        # Leaded ruby and sapphire glass, framed with brass.
        poly=[(s*.17,-.08,.94),(s*.31,-.08,1.19),(s*.59,-.10,1.49),(s*.94,-.14,1.66),(s*1.22,-.18,1.70),(s*1.08,-.17,1.49),(s*.99,-.16,1.27),(s*.70,-.13,1.03),(s*.45,-.10,.98)]
        plate(poly,.012,WING_RED,wing); border(poly,BRASS,wing,.017)
        lower=[poly[0],(s*.52,-.075,1.14),(s*.87,-.13,1.38),poly[5],poly[6],poly[7],poly[8]]
        plate(lower,.014,WING_BLUE,wing); border(lower,BRASS,wing,.010)
        for j in (1,2,3,4,5,6,7): rod(poly[0],poly[j],.011,BRASS,wing)
        # Fine branching leadwork gives each glass panel an etched, dimensional read.
        for a,b in [((.35,1.14),(.51,1.31)),((.51,1.31),(.60,1.48)),
                    ((.51,1.31),(.77,1.43)),((.77,1.43),(.96,1.59)),
                    ((.77,1.43),(1.05,1.48)),((.50,1.13),(.68,1.22)),
                    ((.68,1.22),(.85,1.32)),((.68,1.22),(.78,1.13))]:
            rod((s*a[0],-.055,a[1]),(s*b[0],-.055,b[1]),.006,BRASS,wing)
        rod((s*.38,-.06,1.10),(s*.72,-.11,1.25),.010,BRASS,wing)
        gem((s*.2,-.03,.94),.055,wing)
        rod((s*.22,.30,.72),(s*.37,.58,.51),.055,BRASS,nib,.045)
        rod((s*.37,.58,.51),(s*.43,.79,.35),.053,BRASS,nib,.036)
        nibpts=[(s*.34,.76,.39),(s*.52,.76,.39),(s*.50,1.09,.08),(s*.44,1.18,-.01),(s*.38,1.09,.08)]
        plate(nibpts,.055,IVORY,nib); border(nibpts,BRASS,nib,.012)
        rod((s*.36,.78,.39),(s*.50,.78,.39),.018,BRASS,nib)
        rod((s*.39,1.06,.10),(s*.44,1.15,.015),.009,BRASS,nib)
        rod((s*.44,.81,.35),(s*.44,1.12,.05),.009,DARK,nib)
        P.disc((s*.44,.96,.20),(0,1,0),.018,.02,DARK,nib,n=8)
        for i,y in enumerate((-.30,0,.25)):
            b=f'leg{i}.{n}'; a=(s*.26,y,.64); knee=(s*.52,y+.05,.42); foot=(s*.68,y+.12,.04)
            rod(a,knee,.045,DARK,b,.035); rod(knee,foot,.038,BRASS,b,.014); gem((knee[0],knee[1]+.03,knee[2]),.043,b)

def build_mite():
    global P
    ellipsoid((0,0,.57),(.49,.43,.46),DARK,'body')
    ellipsoid((0,-.04,.78),(.48,.40,.25),BRASS,'body')
    # A separate ivory slot permits a per-instance ruby/ivory stripe tint.
    for x in (-.08,.08):
        if x>0: original=P; P=EXTRA
        stripe=[(x,-.37,.82),(x,-.32,.94),(x,-.12,1.02),(x,.12,1.02),(x,.31,.94),(x,.405,.76),(x,.435,.59)]
        for a,b in zip(stripe,stripe[1:]): rod(a,b,.05,IVORY,'body')
        if x>0: P=original
    P.disc((0,0,1.06),(0,0,1),.13,.14,BRASS,'body'); P.disc((0,0,1.14),(0,0,1),.09,.09,GLOW,'body')
    P.disc((0,0,1.20),(0,0,1),.14,.04,BRASS,'body')
    for y in (-.28,-.10,.10,.28):
        P.ring((0,y,.68),(0,1,0),.445,.33,.012,.012,BRASS,'body',n=20)
    for s,n in [(-1,'L'),(1,'R')]:
        b=f'shutter.{n}'; x=s*.19
        fire=[(x-.135,.39,.50),(x+.135,.39,.50),(x+.135,.39,.81),(x-.135,.39,.81)]
        plate(fire,.095,DARK,'body'); border(fire,BRASS,'body',.025)
        # Projecting side walls and riveted hinge barrels frame a recessed firebox.
        for dx in (-.14,.14):
            rod((x+dx,.40,.49),(x+dx,.48,.49),.022,BRASS,'body')
            rod((x+dx,.40,.82),(x+dx,.48,.82),.022,BRASS,'body')
        rod((s*.36,.47,.49),(s*.36,.47,.82),.034,BRASS,'body')
        for z in (.53,.78): P.disc((s*.36,.47,z),(0,0,1),.042,.035,DARK,'body',n=10)
        for dx in (-.075,0,.075):
            slot=[(x+dx-.022,.447,.54),(x+dx+.022,.447,.54),(x+dx+.022,.447,.77),(x+dx-.022,.447,.77)]
            plate(slot,.012,GLOW,'body')
        poly=[(x-.15,.46,.48),(x+.15,.46,.48),(x+.15,.46,.83),(x-.15,.46,.83)]
        plate(poly,.065,DARK,b); border(poly,BRASS,b,.035)
        inset=[(x-.105,.505,.53),(x+.105,.505,.53),(x+.105,.505,.78),(x-.105,.505,.78)]
        border(inset,BRASS,b,.012)
        rod((x,.51,.53),(x,.51,.78),.014,BRASS,b)
        for z in (.55,.65,.75): rod((x-.075,.52,z),(x+.075,.52,z),.008,BRASS,b)
        for z in (.52,.78): gem((x+s*.10,.51,z),.022,b)
        for i,y in enumerate((-.22,.24)):
            leg=f'leg{i}.{n}'; a=(s*.37,y,.42); knee=(s*.57,y,.27); foot=(s*.69,y+.06,.04)
            rod(a,knee,.07,BRASS,leg,.055); rod(knee,foot,.05,DARK,leg,.035); gem((knee[0],knee[1]+.04,knee[2]),.046,leg)

def build_auditor():
    ellipsoid((0,-.08,.77),(.30,.19,.40),DARK,'body')
    rod((0,0,.47),(0,0,1.02),.065,GLOW,'body')
    for z in (.53,.62,.71,.80,.89): P.ring((0,0,z),(0,0,1),.08,.08,.012,.009,BRASS,'body',n=12)
    for s in (-1,1):
        P.disc((s*.27,-.05,.91),(0,1,0),.15,.07,BRASS,'body',n=16)
        P.disc((s*.27,.00,.91),(0,1,0),.09,.08,DARK,'body',n=16)
    # Two hinged ledger covers and their pale page edges.
    for s,n in [(-1,'L'),(1,'R')]:
        bone=f'cover.{n}';
        for j in range(3):
            page=[(s*.035,.095+j*.012,.94+j*.025),(s*(.25+j*.02),.095+j*.012,1.02+j*.035),(s*(.31+j*.015),.095+j*.012,1.00+j*.035),(s*.035,.095+j*.012,.90+j*.025)]
            plate(page,.009,IVORY,bone)
        p=[(s*.035,.13,.53),(s*.34,.13,.49),(s*.37,.13,1.00),(s*.035,.13,.92)]
        plate(p,.06,DARK,bone); border(p,BRASS,bone,.022)
        rod((s*.10,.18,.57),(s*.29,.18,.88),.009,BRASS,bone)
        for z in (.62,.70,.78):
            rod((s*.10,.175,z),(s*.23,.175,z+.025),.006,IVORY,bone)
        gem((s*.31,.18,.55),.035,bone); gem((s*.32,.18,.94),.035,bone)
    rod((0,-.01,1.0),(0,0,1.32),.045,BRASS,'body')
    mask=[(-.13,.10,1.39),(0,.16,1.19),(.13,.10,1.39),(.11,.10,1.56),(0,.10,1.64),(-.11,.10,1.56)]
    plate(mask,.08,IVORY,'body'); border(mask,BRASS,'body',.015)
    for s in (-1,1):
        rod((s*.12,.0,1.27),(s*.31,0,1.36),.04,BRASS,'body')
        rod((s*.31,0,1.36),(s*.39,0,1.62),.04,BRASS,'body')
        rod((s*.39,0,1.62),(s*.27,0,1.75),.035,BRASS,'body')
        gem((s*.31,.06,1.38),.045,'body')
    # Left arm ends in a large broad stamp; right arm carries a three-row abacus.
    rod((-.28,0,.94),(-.56,.02,.75),.105,BRASS,'stamp'); rod((-.56,.02,.75),(-.77,.06,.48),.085,DARK,'stamp')
    ellipsoid((-.56,.05,.75),(.12,.12,.12),BRASS,'stamp')
    P.disc((-.56,.16,.75),(0,1,0),.075,.04,DARK,'stamp',n=12)
    ellipsoid((-.77,.06,.49),(.12,.12,.10),BRASS,'stamp')
    # A stepped shoulder flares into the broad face of the press.
    p=[(-1.16,.06,.17),(-.50,.06,.17),(-.58,.06,.40),(-.67,.06,.48),(-1.00,.06,.48),(-1.08,.06,.40)]
    plate(p,.34,DARK,'stamp'); border(p,BRASS,'stamp',.045)
    sole=[(-1.19,.06,.15),(-.47,.06,.15),(-.49,.06,.22),(-1.17,.06,.22)]
    plate(sole,.38,BRASS,'stamp'); border(sole,DARK,'stamp',.018)
    inset=[(-1.08,.25,.25),(-.58,.25,.25),(-.62,.25,.39),(-1.04,.25,.39)]
    border(inset,BRASS,'stamp',.015)
    for x in (-1.01,-.83,-.65): gem((x,.25,.31),.025,'stamp')
    rod((.28,0,.94),(.56,.02,.72),.095,BRASS,'abacus')
    frame=[(.60,.08,.42),(1.00,.08,.42),(1.00,.08,.92),(.60,.08,.92)]
    border(frame,BRASS,'abacus',.024)
    for i in range(3):
        z=.52+i*.14; rod((.63,.09,z),(.97,.09,z),.012,BRASS,'abacus')
        ellipsoid((.71+(i%2)*.14,.10,z),(.04,.045,.045),RUBY,f'bead.{i}')

{'glasswing-scrivener':build_scrivener,'furnace-mite':build_mite,'null-crown-auditor':build_auditor}[ID]()
# Lower the suspended elite and its raised stamp within the seated camera.
model_scale=.84 if ID=='null-crown-auditor' else 1
if model_scale!=1:
    for v in P.bm.verts: v.co*=model_scale
    BONES=[(name,parent,tuple(v*model_scale for v in a),tuple(v*model_scale for v in b)) if name!='root' else (name,parent,a,b) for name,parent,a,b in BONES]
# Put the lowest authored point on the floor while keeping the ledger body suspended.
z_offset=min(v.co.z for v in P.bm.verts)
for v in P.bm.verts: v.co.z-=z_offset
if EXTRA:
    for v in EXTRA.bm.verts: v.co.z-=z_offset
BONES=[(name,parent,(a[0],a[1],a[2]-z_offset),(b[0],b[1],b[2]-z_offset)) if name!='root' else (name,parent,a,b) for name,parent,a,b in BONES]
h.BONES=BONES
# Assemble rigid-weighted islands into one skinned mesh.
bmesh.ops.recalc_face_normals(P.bm, faces=P.bm.faces[:])
bmesh.ops.triangulate(P.bm, faces=P.bm.faces[:], quad_method='FIXED', ngon_method='EAR_CLIP')
color=P.bm.loops.layers.float_color.new('tint')
shades={DARK:(.075,.051,.038,1),RUBY:(.36,.015,.035,1),BLUE:(.08,.18,.34,1), WING_RED:(.42,.025,.04,1),WING_BLUE:(.10,.24,.48,1)}
remap={BRASS:0,DARK:1,RUBY:1,GLOW:2,IVORY:3,BLUE:1,WING_RED:3,WING_BLUE:3}
if ID=='glasswing-scrivener':
    remap[IVORY]=3; shades[IVORY]=(.65,.80,.92,1)
for face in P.bm.faces:
    rgba=shades.get(face.material_index,(1,1,1,1))
    for loop in face.loops: loop[color]=rgba
    face.material_index=remap[face.material_index]
me=bpy.data.meshes.new(ID+'-mesh'); P.bm.to_mesh(me); P.bm.free()
me.color_attributes.active_color_name='tint'; me.color_attributes.render_color_index=me.color_attributes.active_color_index
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene; scene.render.fps=30
arm=h.build_armature(bpy,scene,ID)
body=bpy.data.objects.new(ID+'-body',me); scene.collection.objects.link(body)
for name in h.BONE_NAMES: body.vertex_groups.new(name=name)
body.parent=arm; body.modifiers.new('armature','ARMATURE').object=arm
extra_obj=None
if EXTRA:
    bmesh.ops.recalc_face_normals(EXTRA.bm,faces=EXTRA.bm.faces[:]); bmesh.ops.triangulate(EXTRA.bm,faces=EXTRA.bm.faces[:])
    for face in EXTRA.bm.faces: face.material_index=0
    extra_mesh=bpy.data.meshes.new('furnace-mark-extra'); EXTRA.bm.to_mesh(extra_mesh); EXTRA.bm.free()
    extra_obj=bpy.data.objects.new('furnace-mark-extra',extra_mesh); scene.collection.objects.link(extra_obj)
    for name in h.BONE_NAMES: extra_obj.vertex_groups.new(name=name)
    extra_obj.parent=arm; extra_obj.modifiers.new('armature','ARMATURE').object=arm
colors=[((.64,.39,.12,1),.32,.8),((1,1,1,1),.44,.65),((1,.22,.012,1),.38,.1),(((1,1,1,1) if ID=='glasswing-scrivener' else (.8,.68,.48,1)),.35,.25)]
for name,(rgba,rough,metal) in zip(MATS,colors):
    m=bpy.data.materials.new(name); m.diffuse_color=rgba; m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF'); bs.inputs['Base Color'].default_value=rgba;
    if name in ('foundry-dark','foundry-glass'):
        attr=m.node_tree.nodes.new('ShaderNodeVertexColor'); attr.layer_name='tint'; m.node_tree.links.new(attr.outputs['Color'],bs.inputs['Base Color'])
    bs.inputs['Roughness'].default_value=rough; bs.inputs['Metallic'].default_value=metal
    if name=='foundry-glass':
        bs.inputs['Alpha'].default_value=.68; bs.inputs['Metallic'].default_value=0; bs.inputs['Roughness'].default_value=.25
        m.surface_render_method='DITHERED'
    if name=='foundry-glow': bs.inputs['Emission Color'].default_value=rgba; bs.inputs['Emission Strength'].default_value=.8
    me.materials.append(m)
    if extra_obj and name=='foundry-mark': extra_obj.data.materials.append(m)

# Static held intent poses are explicit, individually selectable clips. Each pose starts at rest and
# transitions to its held tell, so the caller can clamp it until the enemy acts.
if ID=='glasswing-scrivener':
    tells={'intent-inscribe':{'nib.R':(30,0,-25)},'intent-cross-out':{'nib.L':(0,-45,0),'nib.R':(0,45,0)},'intent-proof':{'wing.L':(0,0,0),'wing.R':(0,0,0)}}
elif ID=='furnace-mite':
    tells={'intent-double-spark':{'shutter.L':(0,0,75),'shutter.R':(0,0,-75)},'intent-stoke':{'shutter.R':(0,0,-75)},'intent-clink':{'leg0.L':(0,0,18),'leg0.R':(0,0,-18),'leg1.L':(0,0,18),'leg1.R':(0,0,-18)}}
else:
    tells={'intent-tally':{'bead.0':(0,25,0),'bead.1':(0,-25,0)},'intent-reconcile':{'stamp':(0,130,0),'cover.L':(0,0,35),'cover.R':(0,0,-35)},'intent-levy':{'stamp':(0,145,0)}}
clips={'idle':(2,'repeat',{}),'attack':(1,'once',{'impact':.6}),'hit':(.5,'once',{}),'death':(1.5,'once',{'down':1.2}),'frozen':(1,'repeat',{})}
clips.update({name:(.6,'once',{}) for name in tells})
if ID=='null-crown-auditor': clips['action-levy']=(1,'once',{'impact':.6})
arm.animation_data_create(); actions={}
for name,(duration,loop,events) in clips.items():
    act=bpy.data.actions.new(name); act.use_fake_user=True; arm.animation_data.action=act
    for frame in ((0,9,18,30) if name in ('attack','action-levy') else (0,3,9,18) if name=='intent-cross-out' else (0, round(duration*30/2), round(duration*30))):
        for pb in arm.pose.bones:
            if pb.name=='root': continue
            pose={}
            if name in tells and frame>0 and (name!='intent-cross-out' or frame>=9): pose=tells[name]
            elif name=='attack' and frame in (9,18):
                if ID=='glasswing-scrivener': pose={'nib.R':((8 if frame==9 else 20),0,0)}
                elif ID=='furnace-mite': pose={'body':(4,0,0),'shutter.L':(0,0,35 if frame==9 else 110),'shutter.R':(0,0,-35 if frame==9 else -110)}
                else: pose={'bead.0':(0,0,0),'bead.1':(0,0,0)}
            elif name=='action-levy' and frame in (0,9,30): pose={'stamp':(0,45 if frame==30 else 145,0)}
            elif name=='hit' and frame==round(duration*30/2):
                pose=({'nib.L':(0,0,-12),'nib.R':(0,0,12)} if ID=='glasswing-scrivener' else {'shutter.L':(0,0,12),'shutter.R':(0,0,-12)} if ID=='furnace-mite' else {'cover.L':(0,0,12),'cover.R':(0,0,-12)})
            elif name=='death' and frame>0:
                pitch=65 if frame==round(duration*30/2) else 90
                pose={'body':((0,pitch,0) if ID=='glasswing-scrivener' else (pitch,0,0))}
                if ID=='glasswing-scrivener':
                    for bone in h.BONE_NAMES:
                        if bone.startswith(('wing.','nib.','leg')): pose[bone]=(0,-pitch,0)
            elif name=='idle' and frame==round(duration*30/2): pose={'body':(0,0,2)}
            angles=pose.get(pb.name,(0,0,0)); rot=Euler(tuple(math.radians(a) for a in angles),'XYZ').to_quaternion()
            basis=pb.bone.matrix_local.to_quaternion(); pb.rotation_mode='QUATERNION'; pb.rotation_quaternion=basis.inverted() @ rot @ basis
            pb.keyframe_insert(data_path='rotation_quaternion',frame=frame)
            if ID=='glasswing-scrivener' and pb.name.startswith(('wing.','nib.','leg')):
                factor=(.72 if frame==round(duration*30/2) else .42) if name=='death' and frame>0 else 1
                pb.scale=(factor,factor,factor); pb.keyframe_insert(data_path='scale',frame=frame)
            if pb.name.startswith('wing.') or pb.name.startswith('nib.'):
                shift=Vector((0,0,0))
                if name=='attack' and frame==18 and pb.name=='nib.R':
                    shift=Vector((0,.36,-.08))
                elif frame>0 and name=='intent-proof' and pb.name.startswith('wing.'):
                    shift=Vector((.45 if pb.name.endswith('L') else -.45,.68,-.75))
                elif frame>0 and name=='intent-cross-out' and pb.name.startswith('nib.'):
                    shift=Vector((0,0,.12))
                pb.location=basis.inverted() @ shift; pb.keyframe_insert(data_path='location',frame=frame)
            if pb.name.startswith('bead.'):
                shift=.10 if ((name=='intent-tally' and frame>0) or (name=='attack' and frame in (9,18))) and pb.name in ('bead.0','bead.1') else 0
                pb.location=basis.inverted() @ Vector((shift,0,0)); pb.keyframe_insert(data_path='location',frame=frame)
            if pb.name=='body' and ID=='furnace-mite' and name=='attack':
                lift=.025 if frame in (9,18) else 0
                pb.location=basis.inverted() @ Vector((0,0,lift)); pb.keyframe_insert(data_path='location',frame=frame)
            if pb.name.startswith('shutter.'):
                shift=Vector((0,.12 if name=='attack' and frame==18 else 0,0))
                pb.location=basis.inverted() @ shift; pb.keyframe_insert(data_path='location',frame=frame)
            if pb.name=='stamp':
                shift=Vector((0,0,0))
                pb.location=basis.inverted() @ shift; pb.keyframe_insert(data_path='location',frame=frame)
    actions[name]=act
# Keep the collapsed mesh above the floor and settle its final pose onto it.
arm.animation_data.action=actions['death']
body_pose=arm.pose.bones['body']; basis=body_pose.bone.matrix_local.to_quaternion()
for frame in range(1,46):
    scene.frame_set(frame); body_pose.location=(0,0,0); bpy.context.view_layer.update()
    evaluated=body.evaluated_get(bpy.context.evaluated_depsgraph_get()); temp=evaluated.to_mesh()
    zmin=min((evaluated.matrix_world @ v.co).z for v in temp.vertices); evaluated.to_mesh_clear()
    correction=max(-zmin,0)
    if frame>30 and zmin>0: correction=-zmin*((frame-30)/15)
    body_pose.location=basis.inverted() @ Vector((0,0,correction)); body_pose.keyframe_insert(data_path='location',frame=frame)
arm.animation_data.action=None
for pb in arm.pose.bones: pb.rotation_quaternion=(1,0,0,0); pb.location=(0,0,0); pb.scale=(1,1,1)
socket_positions={'socket-hit':(0,0,.7),'socket-eye':(0,.35,.85),'socket-weapon':((-.8,.1,.35) if ID=='null-crown-auditor' else (0,.55,.6))}
socket_positions={name:(pos[0]*model_scale,pos[1]*model_scale,pos[2]*model_scale-z_offset) for name,pos in socket_positions.items()}
sockets=[]
for name,pos in socket_positions.items():
    o=bpy.data.objects.new(name,None); scene.collection.objects.link(o); o.parent=arm; o.parent_type='BONE'; o.parent_bone='body'; bpy.context.view_layer.update(); o.matrix_world=Matrix.Translation(pos); sockets.append(o)
bpy.context.view_layer.update()
staged=OUT/(ID+'.glb')
h.export_glb(bpy,[arm,body,*([extra_obj] if extra_obj else []),*sockets],arm,staged)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/(ID+'.blend')))
# Verify the actual exported bytes with the existing parser and Blender's importer.
g,acc,_=h.parse_glb(staged.read_bytes()); names=[n.get('name','') for n in g['nodes']]; skins=g.get('skins',[])
assert len(skins)==1 and len(skins[0]['joints'])==len(BONES)
assert all(name in names for name in socket_positions)
assert {a['name'] for a in g.get('animations',[])}==set(clips)
import numpy as np
prims=[p for mesh in g['meshes'] for p in mesh['primitives']]
triangles=sum(g['accessors'][p['indices']]['count']//3 for p in prims)
positions=np.concatenate([acc(p['attributes']['POSITION']) for p in prims])
for p in prims:
    weights=acc(p['attributes']['WEIGHTS_0']); assert np.allclose(weights.sum(axis=1),1,atol=.002)
assert triangles < 25000 and len(g.get('materials',[]))<=4
assert np.isfinite(positions).all() and np.isfinite(acc(skins[0]['inverseBindMatrices'])).all()
root_index=names.index('root'); measured_clips={}
for animation in g['animations']:
    times=[acc(sampler['input']) for sampler in animation['samplers']]
    duration=max(float(t.max()) for t in times); start=min(float(t.min()) for t in times)
    assert abs(duration-clips[animation['name']][0])<.05 and abs(start)<.001
    for channel in animation['channels']:
        if channel['target']['node']==root_index:
            values=acc(animation['samplers'][channel['sampler']]['output'])
            assert np.allclose(values,values[0],atol=1e-5)
    measured_clips[animation['name']]={'start':start,'duration':duration,'channels':len(animation['channels'])}
reimport=h.blender_reimport(bpy,staged)
assert reimport['bones']==len(BONES) and {name.rsplit('.',1)[0] for name in reimport['actions']}==set(clips)
manifest={'id':ID,'version':1,'glb':ID+'.glb','frame':{'units':'m','up':'+Y','forward':'-Z','origin':'floor'},'root':ID,'mesh':ID+'-body',
 'bounds':{'min':positions.min(axis=0).round(4).tolist(),'max':positions.max(axis=0).round(4).tolist()},
 'skeleton':{'root':'root','bones':len(BONES),'joints':h.BONE_NAMES,'maxInfluences':1},'rootMotion':'code-owned; root joint fixed',
 'clips':{n:{'duration':d,'loop':l,'events':e,**({'held':True} if n=='frozen' else {})} for n,(d,l,e) in clips.items() if not n.startswith(('intent-','action-'))},
 'intentClips':{n.removeprefix('intent-'):n for n in tells},
 **({'actionClips':{'levy':'action-levy'}} if ID=='null-crown-auditor' else {}),
 'sockets':{n:{'bone':'body','parent':'body','position':[p[0],p[2],-p[1]]} for n,p in socket_positions.items()},
 'emissive':{'material':'foundry-glow','color':'#F3BE65','intensity':.8,'nodes':['socket-hit']},
 'materialSlots':{n:{'set':None,'factorOnly':True,**({'emissive':True} if n=='foundry-glow' else {})} for n in MATS},
 'budget':{'tris':triangles,'materials':len(MATS),'bones':len(BONES),'influences':1}}
(OUT/(ID+'.manifest.json')).write_text(json.dumps(manifest,indent=2)+'\n')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
report={'concept':str((REPO/'assets-source/concepts/foundry'/f'{CONCEPT}.png').relative_to(REPO)),'conceptSha256':sha(REPO/'assets-source/concepts/foundry'/f'{CONCEPT}.png'),
 'conceptApproval':'Paul, 2026-11-18','author':'Codex Blender author','blender':bpy.app.version_string,'generator':'scripts/assets/build-foundry-enemies.py',
 'maxInfluences':int(max((acc(p['attributes']['WEIGHTS_0']) > 1e-6).sum(axis=1).max() for p in prims)),'maxWeightSumError':float(max(np.abs(acc(p['attributes']['WEIGHTS_0']).sum(axis=1)-1).max() for p in prims)),'unweightedVertices':int(sum((acc(p['attributes']['WEIGHTS_0']).sum(axis=1)<1e-6).sum() for p in prims)),
 'glbSha256':sha(staged),'blendSha256':sha(OUT/(ID+'.blend')),'generatorSha256':sha(Path(__file__)),'triangles':triangles,'bones':len(BONES),'measuredClips':measured_clips,'reimport':reimport,'visualApproval':'pending','independentReview':'pending','gameplayLifecycle':'pending'}
(OUT/'provenance.json').write_text(json.dumps(report,indent=2)+'\n')
print('FOUNDRY_RESULT',json.dumps(report))
