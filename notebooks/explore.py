"""Dependency-free rendering helpers shared by the notebook and HTML explorer."""
import csv
import html
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'
COLORS = {'room': '#dfe9ed', 'corridor': '#e9e4d8', 'hall': '#d8eab6', 'stair': '#f9d5ab', 'lift': '#d9c8f5', 'outdoor': '#f1f2ef'}

def load_building(directory=DATA / 'proc-factory-dev-003'):
    return json.loads((Path(directory) / 'building.json').read_text())

def load_manifest():
    with (DATA / 'manifest.csv').open(newline='') as handle:
        return list(csv.DictReader(handle))

def load_questions(name='questions.jsonl', directory=DATA / 'proc-factory-dev-003'):
    return [json.loads(line) for line in (Path(directory) / name).read_text().splitlines() if line.strip()]

def area(polygon):
    """Shoelace area in square metres; not a traversable-area calculation."""
    return abs(sum(p[0]*q[1] - q[0]*p[1] for p, q in zip(polygon, polygon[1:]+polygon[:1]))) / 2

def table(rows, columns=None):
    rows = list(rows)
    if not rows:
        return '<p>No records.</p>'
    columns = columns or list(rows[0])
    esc = lambda value: html.escape(str(value))
    head = ''.join('<th>'+esc(c)+'</th>' for c in columns)
    body = ''.join('<tr>'+''.join('<td>'+esc(row.get(c, ''))+'</td>' for c in columns)+'</tr>' for row in rows)
    return '<div class="table-wrap"><table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>'

def bars(counts, title):
    items = sorted(counts.items(), key=lambda pair: pair[1], reverse=True)
    height = 45 + len(items)*30
    out = [f'<svg role="img" aria-label="{html.escape(title)}" viewBox="0 0 650 {height}" style="width:100%;max-width:760px"><text x="0" y="20" font-size="16">{html.escape(title)}</text>']
    peak = max(counts.values(), default=1)
    for i, (name, count) in enumerate(items):
        y = 38+i*30
        out.append(f'<text x="0" y="{y+15}" font-size="12">{html.escape(str(name))}</text><rect x="190" y="{y}" width="{count/peak*390}" height="20" fill="#92b556" rx="3"/><text x="{198+count/peak*390}" y="{y+15}" font-size="12">{count}</text>')
    return ''.join(out)+'</svg>'

def floor_svg(building, floor_id):
    spaces = [s for s in building['spaces'] if s['floor_id'] == floor_id]
    points = [p for s in spaces for p in s['polygon']]
    if not points:
        return '<p>This floor has no polygons.</p>'
    lo_x, hi_x = min(p[0] for p in points), max(p[0] for p in points)
    lo_y, hi_y = min(p[1] for p in points), max(p[1] for p in points)
    span = max(hi_x-lo_x, hi_y-lo_y, 1)
    pad, stroke, dot = span*.04, span*.0017, span*.004
    out = [f'<svg class="floor-map" role="img" aria-label="Floor plan; hover rooms, doors and equipment for details" viewBox="{lo_x-pad} {-hi_y-pad} {hi_x-lo_x+2*pad} {hi_y-lo_y+2*pad}">']
    for s in spaces:
        tip = html.escape(f"{s['name']} | {s['id']} | {s['room_type']} | {area(s['polygon']):.1f} m² | synthetic={s.get('synthetic', False)}")
        poly = ' '.join(f'{x},{-y}' for x,y in s['polygon'])
        out.append(f'<polygon points="{poly}" fill="{COLORS.get(s["type"], "#eee")}" stroke="#667667" stroke-width="{stroke}"><title>{tip}</title></polygon>')
    for a in building['assets']:
        if a['floor_id'] != floor_id:
            continue
        x,y = a['position']; fp = a.get('footprint', {}); w,h = fp.get('width_m', .4), fp.get('depth_m', .4)
        color = '#347c9a' if a['category'] in ('machine','equipment') else '#809181'
        tip = html.escape(f"{a['name']} | {a['category']} / {a['type']} | space={a['space_id']} | source={a.get('source')}")
        out.append(f'<rect class="asset-mark" x="{x-w/2}" y="{-y-h/2}" width="{w}" height="{h}" transform="rotate({-fp.get("rotation_deg",0)} {x} {-y})" fill="{color}" fill-opacity=".55" stroke="{color}" stroke-width="{stroke/2}"><title>{tip}</title></rect>')
    for o in building['openings']:
        if o['floor_id'] != floor_id:
            continue
        x,y = o['position']; color = '#ce5c32' if not o['step_free'] else '#226c55'
        tip = html.escape(f"{o['id']} | {o['kind']} | width={o['width_m']} m | step_free={o['step_free']} | joins {o['space_ids']}")
        out.append(f'<circle class="door-mark" cx="{x}" cy="{-y}" r="{dot}" fill="{color}"><title>{tip}</title></circle>')
    for s in spaces:
        # Label at bounding-box centre only; never use this approximation for routing.
        xs,ys = zip(*s['polygon']); x,y=(min(xs)+max(xs))/2,(min(ys)+max(ys))/2
        out.append(f'<text class="room-label" pointer-events="none" x="{x}" y="{-y}" text-anchor="middle" font-size="{span*.008}" fill="#203126">{html.escape(s.get("ref", ""))}</text>')
    return ''.join(out)+'</svg>'

STYLE = '''body{font:15px system-ui,sans-serif;background:#f5f6f0;color:#253528;margin:0}main{max-width:1350px;margin:auto;padding:36px}h1{font-size:42px;letter-spacing:-1.5px;margin:10px 0}h2{margin-top:36px}p{line-height:1.7;max-width:900px}small,.muted{color:#617263}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:white;border:1px solid #dce2d5;border-radius:10px;padding:18px;min-width:130px}.card b{display:block;font-size:30px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:30px}section{background:white;padding:24px;border-radius:12px;margin:20px 0;border:1px solid #dce2d5}.floor-map{width:100%;max-height:760px;background:#fafbf8;border:1px solid #dce2d5}.table-wrap{overflow:auto;max-height:420px}table{border-collapse:collapse;font-size:12px;width:100%;text-align:left}th,td{padding:10px;border-bottom:1px solid #e1e6db;vertical-align:top}th{background:#eef3e7;position:sticky;top:0}select,input{font:inherit;padding:9px;border:1px solid #bac6b1;border-radius:5px}label{display:inline-block;margin:8px 18px 12px 0}summary{cursor:pointer;padding:12px;background:#eff4e9}pre{white-space:pre-wrap;font-size:12px;overflow-wrap:anywhere}a{color:#276e55}.legend{display:flex;gap:18px;flex-wrap:wrap;margin:12px 0;font-size:12px}.legend i{width:12px;height:12px;display:inline-block;margin-right:5px}.note{background:#f2f6e9;padding:16px;border-left:3px solid #92b556}@media(max-width:700px){main{padding:18px}h1{font-size:30px}.columns{grid-template-columns:1fr}}'''

def explorer_html(building=None):
    b = building or load_building(); rows = load_manifest(); questions=load_questions(); basic=load_questions('questions_basic.jsonl')
    esc = html.escape
    cards = ''.join(f'<div class="card"><b>{len(b[key])}</b>{label}</div>' for key,label in [('floors','floors'),('spaces','spaces'),('openings','openings'),('vertical_connectors','vertical connectors'),('assets','assets')])
    options=''.join(f'<option value="{esc(f["id"])}">{esc(f["name"])} · level {f["level"]}</option>' for f in b['floors'])
    maps=''.join(f'<div class="floor" data-floor="{esc(f["id"])}" {"hidden" if i else ""}><p>{esc(f["name"])} · elevation {f["elevation_m"]} m · height {f["height_m"]} m</p>{floor_svg(b,f["id"])}</div>' for i,f in enumerate(b['floors']))
    legend=''.join(f'<span><i style="background:{color}"></i>{kind}</span>' for kind,color in COLORS.items())
    assets=[{k:a.get(k,'') for k in ['name','type','category','space_id','floor_id','source']} for a in b['assets']]
    spaces=[dict(name=s['name'], ref=s.get('ref',''), floor=s['floor_id'], type=s['type'], room_type=s['room_type'], polygon_area_m2=round(area(s['polygon']),2), synthetic=s.get('synthetic',False)) for s in b['spaces']]
    examples=''.join(f'<details><summary>{esc(q["kind"])} — {esc(q["question"])}</summary><pre>{esc(json.dumps(q,indent=2))}</pre></details>' for q in questions+basic[:3])
    files=[{'File':'building.json','Contents':'Building metadata, floors, polygons, openings, connectors, assets. Canonical spatial input.'},{'File':'equipment.csv','Contents':'Same asset inventory, flattened with room and floor details.'},{'File':'floor_*.png / .svg','Contents':'Provided plan images, furnished and plain variants. Available in the upstream checkout; not bundled here.'},{'File':'questions.jsonl','Contents':'Real benchmark tasks. Train/dev include inputs and answers; test does not.'},{'File':'questions_basic.jsonl','Contents':'Warm-up locate/count/route examples. Train/dev only.'},{'File':'manifest.csv','Contents':'One row per building across the full dataset, including split, source, license and file path.'}]
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Challenge data explorer</title><style>{STYLE}</style><main>
<p class="muted">LOST & FOUND / DATA EXPLORATION</p><h1>What’s inside the building?</h1><p>A real development sample from Synera’s challenge kit: <strong>{esc(b['building']['name'])}</strong> ({esc(b['building']['id'])}). Hover map elements for exact IDs and properties. This page works offline.</p>
<div class="cards">{cards}</div><section><h2>1. The whole dataset</h2><p>The manifest describes {len(rows)} buildings. Only one development building’s detailed records are bundled here. Counts below describe the manifest, not a validation of every building file.</p><div class="columns"><div>{bars(Counter(r['split'] for r in rows),'Buildings by split')}</div><div>{bars(Counter(r['source'] for r in rows),'Buildings by source')}</div></div>{table(files)}</section>
<section><h2>2. Explore the actual floor plan</h2><label>Floor <select id="floor">{options}</select></label><label><input type="checkbox" id="assets" checked> Equipment footprints</label><label><input type="checkbox" id="doors" checked> Openings</label><label><input type="checkbox" id="labels" checked> Room references</label><div class="legend">{legend}</div>{maps}<p class="muted">Blue = machines/equipment; grey-green = furniture/fixtures; dots = openings (orange means not step-free). Coordinates are metres, X right, Y up. Equipment rectangles use footprint dimensions and rotation. Room labels use bounding-box centres for display only.</p></section>
<section><h2>3. Rooms and equipment</h2><p>Spaces are polygon regions; an asset belongs to a space via <code>space_id</code>. Openings join two spaces; vertical connectors link stops on different floors. An opening containing <code>outside</code> is an entrance.</p><div class="columns"><div>{bars(Counter(s['type'] for s in b['spaces']),'Space types')}</div><div>{bars(Counter(a['category'] for a in b['assets']),'Asset categories')}</div></div><h3>Space inventory</h3>{table(spaces)}<h3>Equipment inventory</h3><label>Filter assets <input id="asset-search" type="search" placeholder="CNC, printer, room ID…"></label><div id="inventory">{table(assets)}</div><p id="asset-count" role="status">{len(assets)} assets</p><h3>How floors connect</h3>{table(b['vertical_connectors'])}</section>
<section><h2>4. What the agent is asked</h2><p>The full benchmark goes beyond finding a printer: geometry, accessibility, reachability, and hypothetical edits. Expand a question to inspect its raw record, including its development answer. These are dev examples; no test questions are used.</p>{examples}<p class="note">This explorer visualizes input data. It does not compute valid routes. Polygon area is the shoelace area of each individual space; adding every polygon can double-count overlapping spaces. The official graph uses Shapely representative points, opening nodes, and specific stair/lift costs.</p></section>
<section><h2>5. Provenance</h2><p>Upstream commit: <code>cb51a6f2e357db743b0c8b2b377fe902ee3ced13</code>. Sample source: {esc(b['building']['source'])}; license: {esc(b['building']['license'])}. {esc(b['building']['attribution'])}.</p><p>Other sources have different licenses. See <a href="data/ATTRIBUTION.md">ATTRIBUTION.md</a> and each manifest row before reusing data. <a href="https://github.com/Synera-GmbH/industrial-agents-hackathon-2026">Challenge repository</a> · <a href="data-exploration.ipynb">Jupyter notebook</a></p></section></main>
<script>
document.getElementById('floor').addEventListener('change', e => document.querySelectorAll('.floor').forEach(el => el.hidden = el.dataset.floor !== e.target.value));
for (const [id, selector] of [['assets','.asset-mark'],['doors','.door-mark'],['labels','.room-label']]) document.getElementById(id).addEventListener('change', e => document.querySelectorAll(selector).forEach(el => el.style.display = e.target.checked ? '' : 'none'));
document.getElementById('asset-search').addEventListener('input', e => {{ let count=0; document.querySelectorAll('#inventory tbody tr').forEach(row => {{row.hidden = !row.textContent.toLowerCase().includes(e.target.value.toLowerCase());if(!row.hidden) count++;}});document.getElementById('asset-count').textContent=count+' assets'; }});
</script></html>'''

if __name__ == '__main__':
    output=HERE / 'data-explorer.html'
    output.write_text(explorer_html(), encoding='utf-8')
    print(output)
