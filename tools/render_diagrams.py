"""Render the Weave design figures in a compact research-paper style.

The diagrams use independently routed orthogonal edges. Geometry checks reject
crossings, collinear overlap, unrelated-node intersections and covered labels.
"""

import json
import math
import os
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.font_manager import FontProperties
from matplotlib.patches import FancyBboxPatch, PathPatch, Polygon
from matplotlib.path import Path as MplPath


SCRIPT_DIR = Path(__file__).resolve().parent
OUT = SCRIPT_DIR.parent / 'docs' / 'assets' if SCRIPT_DIR.name == 'tools' else SCRIPT_DIR
FONT_CANDIDATES = [
    os.environ.get('WEAVE_CJK_FONT', ''),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/System/Library/Fonts/PingFang.ttc',
    'C:/Windows/Fonts/msyh.ttc',
]
FONT_FILE = next((p for p in FONT_CANDIDATES if p and Path(p).is_file()), None)
if FONT_FILE is None:
    raise RuntimeError('Set WEAVE_CJK_FONT to a Chinese font file.')
FONT = FontProperties(fname=FONT_FILE)
matplotlib.rcParams['svg.fonttype'] = 'path'
matplotlib.rcParams['pdf.fonttype'] = 42
matplotlib.rcParams['axes.unicode_minus'] = False

PAPER = '#faf9f6'
BLUE = '#d8edf7'
GREEN = '#dff0d4'
YELLOW = '#fff5cc'
PEACH = '#f9e0d2'
LILAC = '#e9e2f4'
INK = '#343434'
OUTLINE = '#a7a7a3'
GRAY = '#777771'


def rect_hit(a, b, rect, inset=0.8):
    x1, y1, x2, y2 = rect
    x1, y1, x2, y2 = x1+inset, y1+inset, x2-inset, y2-inset
    if abs(a[0]-b[0]) < 1e-7:
        return x1 < a[0] < x2 and max(min(a[1], b[1]), y1) < min(max(a[1], b[1]), y2)
    if abs(a[1]-b[1]) < 1e-7:
        return y1 < a[1] < y2 and max(min(a[0], b[0]), x1) < min(max(a[0], b[0]), x2)
    raise AssertionError('Routes must be orthogonal')


def segments_cross(a, b, c, d):
    ah = abs(a[1]-b[1]) < 1e-7
    ch = abs(c[1]-d[1]) < 1e-7
    if ah == ch:
        fixed_a = a[1] if ah else a[0]
        fixed_c = c[1] if ch else c[0]
        if abs(fixed_a-fixed_c) > 1e-7:
            return False
        aa, bb = sorted((a[0], b[0]) if ah else (a[1], b[1]))
        cc, dd = sorted((c[0], d[0]) if ch else (c[1], d[1]))
        return max(aa, cc) <= min(bb, dd) + 1e-7
    if not ah:
        return segments_cross(c, d, a, b)
    hx1, hx2 = sorted((a[0], b[0]))
    vy1, vy2 = sorted((c[1], d[1]))
    return hx1 <= c[0] <= hx2 and vy1 <= a[1] <= vy2


class Figure:
    def __init__(self, name, width, height):
        self.name, self.width, self.height = name, width, height
        self.fig = plt.figure(figsize=(width/100, height/100), dpi=100, facecolor='white')
        self.ax = self.fig.add_axes([0, 0, 1, 1])
        self.ax.set_xlim(0, width)
        self.ax.set_ylim(height, 0)
        self.ax.axis('off')
        self.nodes = {}
        self.parents = {}
        self.edges = []
        self.labels = []

    def text(self, x, y, text, size=12, bold=False, color=INK, align='center', owner=None):
        artist = self.ax.text(x, y, text, ha=align, va='center', fontsize=size,
                              color=color, fontproperties=FONT,
                              fontweight='bold' if bold else 'normal',
                              linespacing=1.4, zorder=5)
        self.labels.append((artist, owner))
        return artist

    def box(self, key, x, y, w, h, title='', fill=PAPER, parent=None,
            dashed=False, group=False, size=12, subtitle=None, stack=False):
        if stack:
            for offset in (8, 4):
                self.ax.add_patch(FancyBboxPatch((x+offset, y-offset), w, h,
                    boxstyle='round,pad=0,rounding_size=5', facecolor='white',
                    edgecolor='#c5c5c0', linewidth=.8, zorder=1))
        self.ax.add_patch(FancyBboxPatch((x, y), w, h,
            boxstyle='round,pad=0,rounding_size=7' if group else 'round,pad=0,rounding_size=5',
            facecolor=fill, edgecolor=OUTLINE, linewidth=.9,
            linestyle=(0, (2, 2)) if dashed else 'solid', zorder=1))
        self.nodes[key] = (x, y, x+w, y+h)
        self.parents[key] = parent
        if group:
            self.text(x+w-14, y+22, title, 12.5, True, align='right', owner=key)
        elif subtitle:
            self.text(x+w/2, y+h/2-10, title, size, owner=key)
            self.text(x+w/2, y+h/2+17, subtitle, size-2, color=GRAY, owner=key)
        elif title:
            self.text(x+w/2, y+h/2, title, size, owner=key)
        return key

    def allowed(self, key):
        found = set()
        while key:
            found.add(key)
            key = self.parents[key]
        return found

    def arrow(self, key, source, target, points, label=None, label_at=None):
        points = [tuple(map(float, p)) for p in points]
        for a, b in zip(points, points[1:]):
            assert a[0] == b[0] or a[1] == b[1], (key, a, b)
        # End the shaft at the base of a separate arrowhead.
        end, before = points[-1], points[-2]
        length = math.hypot(end[0]-before[0], end[1]-before[1])
        assert length > 12, key
        dx, dy = (end[0]-before[0])/length, (end[1]-before[1])/length
        shaft_end = (end[0]-8*dx, end[1]-8*dy)
        shaft = points[:-1] + [shaft_end]
        vertices, codes = [shaft[0]], [MplPath.MOVETO]
        for index in range(1, len(shaft)-1):
            prev, corner, nxt = shaft[index-1], shaft[index], shaft[index+1]
            l1 = math.hypot(corner[0]-prev[0], corner[1]-prev[1])
            l2 = math.hypot(nxt[0]-corner[0], nxt[1]-corner[1])
            radius = min(7, l1/3, l2/3)
            start = (corner[0]-(corner[0]-prev[0])/l1*radius,
                     corner[1]-(corner[1]-prev[1])/l1*radius)
            stop = (corner[0]+(nxt[0]-corner[0])/l2*radius,
                    corner[1]+(nxt[1]-corner[1])/l2*radius)
            vertices += [start, corner, stop]
            codes += [MplPath.LINETO, MplPath.CURVE3, MplPath.CURVE3]
        vertices.append(shaft[-1]); codes.append(MplPath.LINETO)
        self.ax.add_patch(PathPatch(MplPath(vertices, codes), facecolor='none',
                                   edgecolor=INK, linewidth=.95, zorder=3))
        self.ax.add_patch(Polygon([end, (shaft_end[0]-3*dy, shaft_end[1]+3*dx),
                                   (shaft_end[0]+3*dy, shaft_end[1]-3*dx)],
                                  facecolor=INK, edgecolor='none', zorder=3))
        self.edges.append((key, source, target, points))
        if label:
            assert label_at
            self.text(*label_at, label, size=10.5, color=GRAY)

    def finish(self):
        for i, (key, source, target, points) in enumerate(self.edges):
            exempt = self.allowed(source) | self.allowed(target)
            for a, b in zip(points, points[1:]):
                for node, rect in self.nodes.items():
                    if node not in exempt:
                        assert not rect_hit(a, b, rect), (self.name, key, 'crosses node', node)
                for other, _, _, route in self.edges[i+1:]:
                    for c, d in zip(route, route[1:]):
                        assert not segments_cross(a, b, c, d), (self.name, key, 'crosses edge', other)
        self.fig.canvas.draw()
        renderer = self.fig.canvas.get_renderer()
        inverse = self.ax.transData.inverted()
        for artist, owner in self.labels:
            ext = artist.get_window_extent(renderer=renderer)
            corners = inverse.transform([[ext.x0, ext.y0], [ext.x1, ext.y1]])
            xs, ys = corners[:, 0], corners[:, 1]
            rect = (min(xs), min(ys), max(xs), max(ys))
            assert 0 <= rect[0] and rect[2] <= self.width and 0 <= rect[1] and rect[3] <= self.height, (self.name, 'canvas text overflow', artist.get_text())
            if owner:
                x1, y1, x2, y2 = self.nodes[owner]
                assert x1+3 <= rect[0] and rect[2] <= x2-3 and y1+3 <= rect[1] and rect[3] <= y2-3, (self.name, 'node text overflow', artist.get_text())
            for key, _, _, route in self.edges:
                for a, b in zip(route, route[1:]):
                    assert not rect_hit(a, b, rect, inset=-2), (self.name, key, 'crosses label', artist.get_text())
        OUT.mkdir(parents=True, exist_ok=True)
        self.fig.savefig(OUT/(self.name+'.png'), dpi=180, facecolor='white')
        self.fig.savefig(OUT/(self.name+'.svg'), facecolor='white', metadata={'Date': None})
        svg_file = OUT/(self.name+'.svg')
        svg_file.write_text('\n'.join(line.rstrip() for line in svg_file.read_text().splitlines())+'\n', encoding='utf-8')
        plt.close(self.fig)
        return {'file': self.name, 'nodes': len(self.nodes), 'edges': len(self.edges),
                'edge_crossings': 0, 'edge_overlaps': 0, 'unrelated_node_crossings': 0,
                'label_crossings': 0, 'label_overflows': 0,
                'style': 'paper modules with low-saturation fills and thin routed arrows'}


def architecture():
    f = Figure('01-five-zone-flows', 1360, 880)
    f.box('P', 180, 170, 240, 230, '感知区', group=True)
    f.box('T', 520, 170, 250, 230, '思考区', group=True)
    f.box('A', 870, 170, 240, 230, '行为区', group=True)
    f.box('p1', 205, 232, 190, 48, '来源判断', fill=PEACH, parent='P')
    f.box('p2', 205, 322, 190, 48, '单源直传 / 多源整合', fill=BLUE, parent='P', size=10.5)
    f.box('t1', 548, 232, 194, 48, '召回相关记忆', fill=GREEN, parent='T')
    f.box('t2', 548, 322, 194, 48, '判断与行动意图', fill=BLUE, parent='T')
    f.box('a1', 895, 232, 190, 48, '自主选择行为', fill=YELLOW, parent='A')
    f.box('a2', 895, 322, 190, 48, '语言 / 截图 / 暂缓', fill=PEACH, parent='A', size=11)
    f.arrow('p_internal','p1','p2',[(300,280),(300,322)])
    f.arrow('t_internal','t1','t2',[(645,280),(645,322)])
    f.arrow('a_internal','a1','a2',[(990,280),(990,322)])
    f.box('input', 24, 275, 116, 58, '用户输入', fill='white', size=12)
    f.box('output', 1150, 275, 168, 58, '应用会话框', fill='white', size=12)
    f.arrow('input','input','P',[(140,304),(180,304)])
    f.arrow('percept','P','T',[(420,304),(520,304)],'当前信息',(470,287))
    f.arrow('intent','T','A',[(770,304),(870,304)],'行动意图',(820,287))
    f.arrow('speak','A','output',[(1110,304),(1150,304)])
    f.arrow('screen','A','P',[(990,170),(990,111),(300,111),(300,170)],'原始截图回流',(645,94))
    f.box('D', 100, 555, 250, 240, '驱动区', group=True)
    f.box('d1', 125, 614, 200, 57, '动机与兴趣喜恶', fill=YELLOW, parent='D')
    f.box('d2', 125, 710, 200, 57, '选题 / 唤醒 / 等待', fill=YELLOW, parent='D', size=11)
    f.arrow('d_internal','d1','d2',[(225,671),(225,710)])
    f.box('M', 475, 555, 330, 240, '记忆区', group=True)
    f.box('m1', 506, 606, 266, 45, '人格基础记忆与偏好', fill=LILAC, parent='M', size=11.5)
    f.box('m2', 506, 676, 120, 80, '短期 LRU', fill=YELLOW, parent='M', size=11)
    f.box('m3', 668, 676, 104, 80, '长期归档', fill=GREEN, parent='M', size=11)
    f.arrow('archive','m2','m3',[(626,716),(668,716)])
    f.arrow('drive_task','D','T',[(200,555),(200,452),(550,452),(550,400)],'驱动任务',(368,434))
    f.arrow('progress','T','D',[(577,400),(577,489),(245,489),(245,555)],'进展建议',(391,507))
    f.arrow('memory_query','T','M',[(644,400),(644,555)])
    f.arrow('memory_reply','M','T',[(703,555),(703,400)])
    f.text(609,447,'查询\n记录',10.5,color=GRAY)
    f.text(748,486,'相关\n记忆',10.5,color=GRAY)
    f.arrow('drive_write','D','M',[(350,629),(475,629)],'查询 / 状态',(412,612))
    f.arrow('memory_cue','M','D',[(475,704),(350,704)],'记忆 / 线索',(412,724))
    f.arrow('action_result','A','M',[(990,400),(990,730),(805,730)],'执行回执',(1025,556))
    f.arrow('drive_result','A','D',[(1060,400),(1060,815),(275,815),(275,795)],'行动结果',(935,796))
    for x, color, label in [(140,LILAC,'人格'),(340,BLUE,'信息与思考'),(600,YELLOW,'选择与驱动'),(850,GREEN,'记忆召回与归档'),(1090,PEACH,'外界与行为')]:
        f.box('legend_'+label,x,837,17,15,fill=color)
        f.text(x+27,845,label,10.5,color=GRAY,align='left')
    return f.finish()


def persona():
    f=Figure('02-persona-startup',1280,820)
    f.text(50,75,'(a) 人格配置',13,True,align='left')
    f.text(495,112,'(b) 校验与初始化',13,True,align='left')
    f.box('profile',50,130,345,480,'人格设定',group=True)
    labels=[('identity','身份与表达',PAPER),('base','基础记忆',LILAC),('interest','兴趣',GREEN),('taste','喜好与厌恶',PEACH),('motive','内生动机',YELLOW)]
    for index,(key,label,color) in enumerate(labels):
        f.box(key,82,200+index*74,280,51,label,fill=color,parent='profile',stack=(key=='base'))
    f.box('txn',495,165,335,400,'初始化事务',group=True,dashed=True)
    f.box('validate',535,241,255,66,'检查必填项',subtitle='允许明确声明无喜恶',fill=YELLOW,parent='txn')
    f.box('persist',535,364,255,110,'人格版本与基础记忆',subtitle='一次性持久化',fill=GREEN,parent='txn',stack=True)
    f.arrow('txn_inner','validate','persist',[(662,307),(662,364)])
    f.arrow('load','profile','txn',[(395,363),(495,363)])
    f.box('ready',965,315,240,100,'READY',subtitle='允许自主运行',fill=GREEN,size=15)
    f.arrow('success','txn','ready',[(830,363),(965,363)],'提交成功',(896,345))
    f.box('setup',505,650,315,85,'PERSONA_SETUP',subtitle='补全配置后重新保存',fill=PEACH,size=14)
    f.arrow('failure','txn','setup',[(662,565),(662,650)],'校验或写入失败',(769,606))
    f.arrow('edit','setup','profile',[(505,692),(225,692),(225,610)],'修改人格配置',(365,674))
    f.box('active',950,500,265,135,'记忆 · 驱动',subtitle='思考 · 行为共同使用人格',fill=LILAC,size=14)
    f.arrow('activate','ready','active',[(1085,415),(1085,500)],'载入当前人格',(1170,458))
    f.text(640,774,'基础记忆保留配置来源和版本，后续交互经历另行积累。',12,color=GRAY)
    return f.finish()


def lifecycle():
    f=Figure('03-topic-transitions',1280,930)
    panels=[('main',40,'(a) 开题与交流'),('defer',455,'(b) 暂缓重评'),('cool',870,'(c) 无回应冷却')]
    for key,x,title in panels:
        f.text(x,57,title,13,True,align='left')
        f.box(key,x,100,370,635,'',group=True)
    main=[('candidate','候选','CANDIDATE',BLUE),('selected','已选择','SELECTED',YELLOW),('offered','已提交开题','OFFERED',PEACH),('engaged','用户参与','ENGAGED',GREEN),('closed','结束','CLOSED',PAPER)]
    for i,(key,title,subtitle,color) in enumerate(main):
        y=145+i*117
        f.box(key,95,y,255,75,title,subtitle=subtitle,fill=color,parent='main',size=12.5)
        if i:
            prev=main[i-1][0]
            f.arrow('main_'+key,prev,key,[(222,145+(i-1)*117+75),(222,y)])
    for parent,x,prefix,items,conditions in [
        ('defer',510,'d',[('已选择','SELECTED',YELLOW),('暂缓','DEFERRED',PEACH),('重新候选','CANDIDATE',BLUE)],['行为选择 NOOP','等待条件满足']),
        ('cool',925,'c',[('已提交开题','OFFERED',PEACH),('冷却','COOLDOWN',YELLOW),('重新候选','CANDIDATE',BLUE)],['等待窗口内无回应','到期且有合适切入点'])]:
        for i,(title,subtitle,color) in enumerate(items):
            key=prefix+str(i); y=173+i*205
            f.box(key,x,y,260,82,title,subtitle=subtitle,fill=color,parent=parent,size=12.5)
            if i:
                prev=prefix+str(i-1)
                py=173+(i-1)*205+82
                f.arrow(prefix+'_step'+str(i),prev,key,[(x+130,py),(x+130,y)])
                f.text(x+150,(py+y)/2,conditions[i-1],9.5,color=GRAY,align='left')
    f.text(40,784,'(d) 终止条件',13,True,align='left')
    f.box('any',288,807,290,75,'任一未关闭的话题',fill=PAPER)
    f.box('end',818,807,255,75,'结束',subtitle='CLOSED',fill=PAPER)
    f.arrow('end_any','any','end',[(578,844),(818,844)],'明确拒绝或过期',(698,826))
    return f.finish()


def opening():
    f=Figure('04-autonomous-opening',1340,790)
    panels=[('prereq',50,'(a) 人格与启动前提'),('decide',480,'(b) 自主选题与决策'),('deliver',910,'(c) 提交与显示')]
    columns=[
        [('有效人格配置', '基础记忆与兴趣喜恶',LILAC),('基础记忆已落盘','人格初始化完成',GREEN),('READY 且会话可用','开始计算开题时间',PAPER),('BOOTSTRAP','就绪后 10 秒唤醒',YELLOW)],
        [('记忆区召回','人格与相关交互经历',GREEN),('驱动区选题','自主产生具体话题',YELLOW),('思考区组织内容','查询记忆并形成意图',BLUE),('行为区决定 SPEAK','独立生成实际语言',PEACH)],
        [('COMMITTED','会话消息持久化',PEACH),('客户端渲染','实际呈现消息',PAPER),('DISPLAYED','收到显示回执',GREEN),('等待与再次评估','用户回应或退避到期',YELLOW)],
    ]
    for col,(parent,x,title) in enumerate(panels):
        f.text(x,57,title,13,True,align='left')
        f.box(parent,x,102,355,577,'',group=True,dashed=(parent=='decide'))
        for i,(title,subtitle,color) in enumerate(columns[col]):
            key=f'n{col}_{i}'; y=148+i*133
            f.box(key,x+36,y,283,83,title,subtitle=subtitle,fill=color,parent=parent,size=12.5)
            if i:
                f.arrow(f'v{col}_{i}',f'n{col}_{i-1}',key,[(x+177,148+(i-1)*133+83),(x+177,y)])
    f.arrow('bootstrap_to_recall','n0_3','n1_0',[(369,588),(438,588),(438,189),(516,189)])
    f.arrow('speech_to_commit','n1_3','n2_0',[(799,588),(868,588),(868,189),(946,189)])
    f.text(670,719,'从左至右，列内自上而下；整个过程不依赖用户聊天输入或截图。',12,color=GRAY)
    f.text(670,756,'首次开题目标：人格初始化完成且会话就绪后 120 秒内实际显示。',11.5,color=GRAY)
    return f.finish()


if __name__ == '__main__':
    report=[architecture(),persona(),lifecycle(),opening()]
    (OUT/'diagram-checks.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
