"""Convert dsh SVG glyphs (ui-primitives artwork.ts, PermissionIcon.tsx, FishLogo.tsx) into Android VectorDrawables."""
import re, sys, os
import xml.etree.ElementTree as ET

src, out = sys.argv[1], sys.argv[2]
STROKE = 1.0
os.makedirs(out, exist_ok=True)

def camel_to_kebab(s): return re.sub(r'([A-Z])', lambda m: '-' + m.group(1).lower(), s)

def fmt(v):
    s = ('%.4f' % v).rstrip('0').rstrip('.')
    return s if s not in ('-0', '') else '0'

def circle_d(cx, cy, r):
    return f"M{fmt(cx-r)},{fmt(cy)}a{fmt(r)},{fmt(r)} 0 1,0 {fmt(2*r)},0a{fmt(r)},{fmt(r)} 0 1,0 {fmt(-2*r)},0Z"

def rect_d(x, y, w, h, rx, ry):
    if rx == 0 and ry == 0:
        return f"M{fmt(x)},{fmt(y)}h{fmt(w)}v{fmt(h)}h{fmt(-w)}Z"
    rx = min(rx, w/2); ry = min(ry, h/2)
    return (f"M{fmt(x+rx)},{fmt(y)}h{fmt(w-2*rx)}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(rx)},{fmt(ry)}v{fmt(h-2*ry)}"
            f"a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(-rx)},{fmt(ry)}h{fmt(-(w-2*rx))}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(-rx)},{fmt(-ry)}"
            f"v{fmt(-(h-2*ry))}a{fmt(rx)},{fmt(ry)} 0 0 1 {fmt(rx)},{fmt(-ry)}Z")

def convert(name, svg):
    svg = re.sub(r'\s(\w+)=\{([^}]*)\}', lambda m: f' {m.group(1)}="{m.group(2)}"', svg)
    svg = re.sub(r'(\s)([a-z]+[A-Z][A-Za-z]*)=', lambda m: m.group(1) + (m.group(2) if m.group(2) == 'viewBox' else camel_to_kebab(m.group(2))) + '=', svg)
    svg = svg.replace('xmlns="http://www.w3.org/2000/svg"', '')
    svg = re.sub(r'xmlns:xlink="[^"]*"', '', svg)
    root = ET.fromstring(svg)
    vb = [float(x) for x in root.get('viewBox').split()]
    paths = []
    def walk(el, inherited):
        attrs = dict(inherited)
        for k, v in el.attrib.items():
            if k in ('stroke', 'fill', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity'):
                attrs[k] = v
        tag = el.tag
        if tag == 'mask': return
        d = None
        if tag == 'path': d = el.get('d')
        elif tag == 'circle': d = circle_d(float(el.get('cx', 0)), float(el.get('cy', 0)), float(el.get('r')))
        elif tag == 'rect':
            rx = float(el.get('rx', el.get('ry', 0))); ry = float(el.get('ry', rx))
            d = rect_d(float(el.get('x', 0)), float(el.get('y', 0)), float(el.get('width')), float(el.get('height')), rx, ry)
        if d:
            paths.append((d, attrs))
        for c in el: walk(c, attrs)
    walk(root, {'fill': root.get('fill', 'black'), 'stroke-width': root.get('stroke-width', str(STROKE))})
    lines = [f'<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="{fmt(vb[2])}dp" android:height="{fmt(vb[3])}dp" '
             f'android:viewportWidth="{fmt(vb[2])}" android:viewportHeight="{fmt(vb[3])}">']
    for d, a in paths:
        p = [f'android:pathData="{d}"']
        fill = a.get('fill', 'black'); stroke = a.get('stroke')
        if fill and fill != 'none': p.append('android:fillColor="#FF000000"')
        if stroke and stroke != 'none':
            p.append('android:strokeColor="#FF000000"')
            sw = a.get('stroke-width', str(STROKE))
            try: float(sw)
            except ValueError: sw = str(STROKE)
            p.append(f'android:strokeWidth="{sw}"')
            if 'stroke-linecap' in a: p.append(f'android:strokeLineCap="{a["stroke-linecap"]}"')
            if 'stroke-linejoin' in a: p.append(f'android:strokeLineJoin="{a["stroke-linejoin"]}"')
        if a.get('fill-rule') == 'evenodd': p.append('android:fillType="evenOdd"')
        if 'opacity' in a:
            p.append(f'android:fillAlpha="{a["opacity"]}"'); p.append(f'android:strokeAlpha="{a["opacity"]}"')
        lines.append('  <path ' + ' '.join(p) + '/>')
    lines.append('</vector>')
    fn = 'dsw_' + name.replace('-', '_') + '.xml'
    open(os.path.join(out, fn), 'w').write('\n'.join(lines) + '\n')
    return fn

art = open(os.path.join(src, 'ui-primitives/src/icons/artwork.ts')).read()
count = 0
for m in re.finditer(r"^  '([a-z0-9-]+)': \{ size: [^\n]*?svg: (.*?)(?=^  '[a-z0-9-]+': \{|^\} as const)", art, re.S | re.M):
    name, body = m.group(1), m.group(2)
    svgs = re.findall(r'[`\'](<svg.*?</svg>)[`\']', body, re.S)
    if not svgs: print('skip', name); continue
    svg = svgs[-1].replace('${strokeWidth}', str(STROKE))
    convert(name, svg); count += 1

pi = open(os.path.join(src, 'ui-primitives/src/PermissionIcon.tsx')).read()
for fn_name, name in [('ReadOnlyArtwork', 'perm-read-only'), ('WorkspaceWriteArtwork', 'perm-workspace-write'), ('FullAccessArtwork', 'perm-full-access'), ('AutoReviewArtwork', 'perm-auto-review')]:
    body = pi[pi.index('function ' + fn_name):]
    svg = re.search(r'(<svg.*?</svg>)', body, re.S).group(1)
    svg = re.sub(r'\s(width|height|className|aria-hidden)=\{?[^\s>]*\}?', '', svg)
    svg = svg.replace('strokeWidth={strokeWidth}', f'stroke-width="{STROKE}"')
    convert(name, svg); count += 1

fish = open(os.path.join(src, 'ui-primitives/src/FishLogo.tsx')).read()
vbw = re.search(r'width:\s*([\d.]+)', fish).group(1); vbh = re.search(r'height:\s*([\d.]+)', fish).group(1)
d = re.search(r"FISH_LOGO_PATH\s*=\s*['\"`]([^'\"`]+)", fish).group(1)
convert('whale', f'<svg viewBox="0 0 {vbw} {vbh}" fill="none"><path d="{d}" fill="currentColor"/></svg>'); count += 1
print('converted', count)
