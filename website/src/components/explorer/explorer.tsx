'use client';

import { createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import type { ArtManifest } from '@/lib/art';
import { MicButton } from '@/components/mic-button';
import type { Asset, Building, CatalogEntry, Space } from '@/lib/buildings/types';
import { ASSET_COLORS, ROOM_LEGEND, humanize, polygonArea, polygonPerimeter, roomColor } from '@/lib/buildings/geometry';
import type { Layers, Selection } from './scene';
import './explorer.css';

const Scene = dynamic(() => import('./scene'), { ssr: false, loading: () => <div className="scene-loading">Preparing 3D view…</div> });

const SOURCE_LABELS: Record<string, string> = {
  procedural: 'Campus & factory',
  osm_indoor: 'OpenStreetMap',
  swiss_dwellings: 'Swiss dwellings',
  resplan: 'ResPlan homes',
};
const DEFAULT_BUILDING = 'proc-factory-dev-005';
const LAYER_LABELS: Record<keyof Layers, string> = { assets: 'Equipment', labels: 'Labels', connectors: 'Stairs & lifts', accessibility: 'Accessibility' };
const MAX_RESULTS = 40;

type Hover = { kind: 'space' | 'asset'; id: string } | null;

const IconContext = createContext<Set<string>>(new Set());

/** Generated icon for an asset type, or a category swatch while it doesn't exist yet. */
function AssetIcon({ asset, size }: { asset: Pick<Asset, 'type' | 'category'>; size: number }) {
  const icons = useContext(IconContext);
  if (!icons.has(asset.type)) return <i className="asset-swatch" style={{ background: ASSET_COLORS[asset.category], width: size * 0.45, height: size * 0.45 }} />;
  return <Image className="asset-icon" src={`/art/icons/${asset.type}.png`} alt="" width={size} height={size} />;
}

export function Explorer({ catalog, art, initialId }: { catalog: CatalogEntry[]; art: ArtManifest; initialId?: string }) {
  const icons = useMemo(() => new Set(art.icons), [art.icons]);
  const [buildingId, setBuildingId] = useState<string>(() =>
    [initialId, DEFAULT_BUILDING].find(id => catalog.some(entry => entry.id === id)) ?? catalog[0]?.id);
  const [building, setBuilding] = useState<Building | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  const [activeLevel, setActiveLevel] = useState<number | 'all'>('all');
  const [explode, setExplode] = useState(1.6);
  const [wallHeight, setWallHeight] = useState(1.4);
  const [layers, setLayers] = useState<Layers>({ assets: true, labels: true, connectors: true, accessibility: false });
  const [viewMode, setViewMode] = useState<'3d' | 'plan'>('3d');
  const [selection, setSelection] = useState<Selection>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const tooltip = useRef<HTMLDivElement>(null);
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null);

  // Keep ?b=<id> in the URL so a view can be shared, and load the building.
  useEffect(() => {
    if (!buildingId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('b', buildingId);
    window.history.replaceState(null, '', url);
    const controller = new AbortController();
    fetch(`/api/buildings/${encodeURIComponent(buildingId)}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error((await response.json()).error ?? 'Could not load building.'); return response.json(); })
      .then((data: Building) => {
        setBuilding(data);
        const levels = data.floors.map(floor => floor.level);
        setActiveLevel(levels.length > 1 ? 'all' : levels[0] ?? 'all');
      })
      .catch(err => { if (err.name !== 'AbortError') setFailure({ id: buildingId, message: err.message }); });
    return () => controller.abort();
  }, [buildingId]);

  const error = failure?.id === buildingId ? failure.message : null;
  const loading = !!buildingId && building?.building.id !== buildingId && !error;
  const floors = useMemo(() => (building ? [...building.floors].sort((a, b) => b.level - a.level) : []), [building]);
  const index = useMemo(() => {
    if (!building) return null;
    return {
      spaces: new Map(building.spaces.map(space => [space.id, space])),
      assets: new Map(building.assets.map(asset => [asset.id, asset])),
      floors: new Map(building.floors.map(floor => [floor.id, floor])),
    };
  }, [building]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (!next || !index) return;
    const item = next.kind === 'space' ? index.spaces.get(next.id) : index.assets.get(next.id);
    const level = item && index.floors.get(item.floor_id)?.level;
    if (level !== undefined) setActiveLevel(level);
  }, [index]);

  const onHover = useCallback((next: Hover, x: number, y: number) => {
    setHover(current => (current?.id === next?.id ? current : next));
    if (tooltip.current) tooltip.current.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
  }, []);

  // Keyboard: ↑/↓ floors, Esc clears, F reframes, P toggles plan view.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.target as HTMLElement)?.closest('input, select, textarea')) return;
      if (event.key === 'Escape') setSelection(null);
      else if (event.key === 'f') setFocusToken(token => token + 1);
      else if (event.key === 'p') setViewMode(mode => (mode === '3d' ? 'plan' : '3d'));
      else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && floors.length) {
        event.preventDefault();
        const levels = floors.map(floor => floor.level).reverse();
        setActiveLevel(current => {
          if (current === 'all') return event.key === 'ArrowUp' ? levels[levels.length - 1] : levels[0];
          const i = levels.indexOf(current) + (event.key === 'ArrowUp' ? 1 : -1);
          return i >= levels.length ? 'all' : levels[Math.max(0, i)];
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [floors]);

  const hoverItem = hover && index ? (hover.kind === 'space' ? index.spaces.get(hover.id) : index.assets.get(hover.id)) : undefined;
  const catalogEntry = catalog.find(entry => entry.id === buildingId);

  return (
    <IconContext value={icons}>
    <div className={`explorer ${sidebarOpen ? '' : 'sidebar-closed'}`}>
      <Catalog catalog={catalog} activeId={buildingId} onPick={id => { setBuildingId(id); setSelection(null); setHover(null); }} onClose={() => setSidebarOpen(false)} />

      <main className="stage">
        {building && !error && (
          <Scene
            building={building} textures={art.textures} models={art.models} activeLevel={activeLevel} explode={explode} wallHeight={wallHeight} layers={layers} viewMode={viewMode}
            selection={selection} hoverId={hover?.id ?? null} focusToken={focusToken} onSelect={select} onHover={onHover} labelLayer={labelLayer}
          />
        )}
        <div ref={setLabelLayer} className="label-layer" aria-hidden />
        {loading && <div className="scene-loading">Loading {catalogEntry?.name ?? 'building'}…</div>}
        {error && <div className="scene-loading error">{error}</div>}

        <header className="stage-top">
          {!sidebarOpen && <button className="chip" onClick={() => setSidebarOpen(true)} aria-label="Show buildings">☰ Buildings</button>}
          <div className="title-card">
            <p className="eyebrow">{catalogEntry ? `${SOURCE_LABELS[catalogEntry.source] ?? catalogEntry.source} · ${catalogEntry.split}` : 'Building'}</p>
            <h1>{building?.building.name ?? catalogEntry?.name ?? '…'}</h1>
            {building && <p className="stats"><span>{building.floors.length} floor{building.floors.length === 1 ? '' : 's'}</span><span>{building.spaces.length} spaces</span><span>{building.assets.length} assets</span><span>{building.vertical_connectors.length} stairs & lifts</span></p>}
          </div>
          {building && index && <BuildingSearch key={building.building.id} building={building} index={index} onPick={select} />}
        </header>

        {floors.length > 0 && (
          <nav className="floor-stack" aria-label="Floors">
            {floors.length > 1 && <button className={activeLevel === 'all' ? 'active' : ''} onClick={() => setActiveLevel('all')}>All</button>}
            {floors.map(floor => (
              <button key={floor.id} className={activeLevel === floor.level ? 'active' : ''} onClick={() => setActiveLevel(floor.level)} title={floor.name}>
                {floor.level === 0 ? 'G' : floor.level > 0 ? floor.level : `B${-floor.level}`}
              </button>
            ))}
            <span className="hint">↑ ↓</span>
          </nav>
        )}

        <div className="toolbar">
          <div className="segmented">
            <button className={viewMode === '3d' ? 'active' : ''} onClick={() => setViewMode('3d')}>3D</button>
            <button className={viewMode === 'plan' ? 'active' : ''} onClick={() => setViewMode('plan')}>Plan</button>
          </div>
          <label className="slider">Floor gap<input type="range" min={1} max={4} step={0.1} value={explode} onChange={event => setExplode(Number(event.target.value))} /></label>
          <label className="slider">Walls<input type="range" min={0.1} max={3.2} step={0.1} value={wallHeight} onChange={event => setWallHeight(Number(event.target.value))} /></label>
          <div className="toggles">
            {(Object.keys(layers) as (keyof Layers)[]).map(key => (
              <button key={key} className={layers[key] ? 'active' : ''} aria-pressed={layers[key]} onClick={() => setLayers(current => ({ ...current, [key]: !current[key] }))}>{LAYER_LABELS[key]}</button>
            ))}
          </div>
          <button className="chip" onClick={() => setFocusToken(token => token + 1)} title="Reframe (F)">⤢ Reframe</button>
        </div>

        <Legend />

        {building && index && selection && (
          <Details building={building} index={index} selection={selection} onSelect={select} onClose={() => setSelection(null)} />
        )}

        <div ref={tooltip} className={`tooltip ${hoverItem ? 'visible' : ''}`} aria-hidden>
          {hoverItem && ('polygon' in hoverItem
            ? <><b>{hoverItem.name}</b><span>{humanize(hoverItem.room_type)} · {polygonArea(hoverItem.polygon).toFixed(1)} m²</span></>
            : <div className="tooltip-asset"><AssetIcon asset={hoverItem} size={44} /><div><b>{hoverItem.name}</b><span>{humanize(hoverItem.type)} · {hoverItem.category}</span></div></div>)}
        </div>
      </main>
    </div>
    </IconContext>
  );
}

function Catalog({ catalog, activeId, onPick, onClose }: { catalog: CatalogEntry[]; activeId: string; onPick: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<string | 'all'>('all');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const sources = useMemo(() => [...new Set(catalog.map(entry => entry.source))], [catalog]);
  const results = useMemo(() => catalog
    .filter(entry => (source === 'all' || entry.source === source) && (!deferred || `${entry.name} ${entry.id}`.toLowerCase().includes(deferred)))
    .sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId) || b.floors - a.floors || b.rooms - a.rooms), [catalog, source, deferred, activeId]);
  return (
    <aside className="catalog">
      <div className="brand-row">
        <span className="brand">◈ <b>lost & found</b></span>
        <button className="icon" onClick={onClose} aria-label="Hide buildings">‹</button>
      </div>
      <p className="eyebrow">{catalog.length} BUILDINGS</p>
      <input className="search" placeholder="Search buildings…" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search buildings" />
      <div className="source-chips">
        <button className={source === 'all' ? 'active' : ''} onClick={() => setSource('all')}>All</button>
        {sources.map(item => <button key={item} className={source === item ? 'active' : ''} onClick={() => setSource(item)}>{SOURCE_LABELS[item] ?? item}</button>)}
      </div>
      <ul className="building-list">
        {results.map(entry => (
          <li key={entry.id}>
            <button className={entry.id === activeId ? 'active' : ''} onClick={() => onPick(entry.id)}>
              <span className="name">{entry.name}</span>
              <span className="meta">{entry.floors} fl · {entry.rooms} rooms · {entry.assets} assets{entry.hasLift ? ' · lift' : ''}</span>
              <span className="id">{entry.id}</span>
            </button>
          </li>
        ))}
        {!results.length && <li className="empty">No buildings match.</li>}
      </ul>
    </aside>
  );
}

type Index = { spaces: Map<string, Space>; assets: Map<string, Asset>; floors: Map<string, Building['floors'][number]> };

function BuildingSearch({ building, index, onPick }: { building: Building; index: Index; onPick: (selection: Selection) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const results = useMemo(() => {
    const words = deferred.replaceAll('_', ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const match = (text: string) => { const lowered = text.toLowerCase().replaceAll('_', ' '); return words.every(word => lowered.includes(word)); };
    const spaces = building.spaces.filter(space => match(`${space.name} ${space.ref ?? ''} ${space.room_type}`)).map(space => ({ kind: 'space' as const, id: space.id, name: space.name, detail: humanize(space.room_type), floor: space.floor_id }));
    const assets = building.assets.filter(asset => match(`${asset.name} ${asset.type}`)).map(asset => ({ kind: 'asset' as const, id: asset.id, name: asset.name, detail: index.spaces.get(asset.space_id)?.name ?? '', floor: asset.floor_id, asset }));
    return [...spaces, ...assets].slice(0, MAX_RESULTS);
  }, [deferred, building, index]);
  return (
    <div className="building-search" onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <div className="search-field">
        <input placeholder="Find a room or equipment…  e.g. printer, kitchen, CNC" value={query} onChange={event => setQuery(event.target.value)} aria-label="Find in building" />
        <MicButton onTranscript={text => { setVoiceError(null); setQuery(text.replace(/[.?!]+$/, '')); setOpen(true); }} onError={setVoiceError} />
      </div>
      {voiceError && <p className="voice-error" role="alert">{voiceError}</p>}
      {open && deferred && (
        <ul className="search-results">
          {results.map(result => (
            <li key={result.id}>
              <button onClick={() => { onPick({ kind: result.kind, id: result.id }); setOpen(false); }}>
                {'asset' in result ? <AssetIcon asset={result.asset} size={32} /> : <i className="space" />}
                <span><b>{result.name}</b><small>{result.detail} · {index.floors.get(result.floor)?.name}</small></span>
              </button>
            </li>
          ))}
          {!results.length && <li className="empty">Nothing called “{query}”.</li>}
        </ul>
      )}
    </div>
  );
}

function Details({ building, index, selection, onSelect, onClose }: { building: Building; index: Index; selection: NonNullable<Selection>; onSelect: (selection: Selection) => void; onClose: () => void }) {
  if (selection.kind === 'asset') {
    const asset = index.assets.get(selection.id);
    if (!asset) return null;
    const room = index.spaces.get(asset.space_id);
    return (
      <aside className="details">
        <button className="icon close" onClick={onClose} aria-label="Close details">×</button>
        <div className="asset-hero"><AssetIcon asset={asset} size={120} /></div>
        <p className="eyebrow"><i className="swatch" style={{ background: ASSET_COLORS[asset.category] }} />{asset.category}</p>
        <h2>{asset.name}</h2>
        <dl>
          <dt>Type</dt><dd>{humanize(asset.type)}</dd>
          <dt>Floor</dt><dd>{index.floors.get(asset.floor_id)?.name}</dd>
          {asset.footprint && <><dt>Footprint</dt><dd>{asset.footprint.width_m} × {asset.footprint.depth_m} m</dd></>}
          <dt>Position</dt><dd>{asset.position[0].toFixed(1)}, {asset.position[1].toFixed(1)} m</dd>
        </dl>
        {room && <button className="link-card" onClick={() => onSelect({ kind: 'space', id: room.id })}><small>Located in</small><b>{room.name}</b><span>→</span></button>}
        <p className="id">{asset.id}</p>
      </aside>
    );
  }
  const space = index.spaces.get(selection.id);
  if (!space) return null;
  const assets = building.assets.filter(asset => asset.space_id === space.id);
  const doors = building.openings.filter(opening => opening.space_ids.includes(space.id));
  const connectors = building.vertical_connectors.filter(connector => connector.space_ids.includes(space.id));
  const byCategory = (['machine', 'equipment', 'fixture', 'furniture'] as const)
    .map(category => [category, assets.filter(asset => asset.category === category)] as const)
    .filter(([, items]) => items.length);
  return (
    <aside className="details">
      <button className="icon close" onClick={onClose} aria-label="Close details">×</button>
      <p className="eyebrow"><i className="swatch" style={{ background: roomColor(space) }} />{humanize(space.room_type)}</p>
      <h2>{space.name}</h2>
      <dl>
        {space.ref && <><dt>Ref</dt><dd>{space.ref}</dd></>}
        <dt>Floor</dt><dd>{index.floors.get(space.floor_id)?.name}</dd>
        <dt>Area</dt><dd>{polygonArea(space.polygon).toFixed(1)} m²</dd>
        <dt>Perimeter</dt><dd>{polygonPerimeter(space.polygon).toFixed(1)} m</dd>
      </dl>
      {connectors.map(connector => (
        <p key={connector.id} className="connector-note"><i className={connector.kind} />{connector.name}: {connector.floor_ids.map(id => index.floors.get(id)?.name).join(' · ')}{connector.step_free ? ' · step-free' : ''}</p>
      ))}
      {doors.length > 0 && <>
        <p className="eyebrow section">Connected to · {doors.length}</p>
        <ul className="doors">
          {doors.map(door => {
            const other = door.space_ids.find(id => id !== space.id) ?? '';
            const target = index.spaces.get(other);
            return (
              <li key={door.id}>
                <button disabled={!target} onClick={() => target && onSelect({ kind: 'space', id: target.id })}>
                  <i className={door.kind === 'entrance' ? 'entrance' : door.step_free ? 'step-free' : 'step'} />
                  <span>{target?.name ?? (other === 'outside' ? 'Outside' : other)}</span>
                  <small>{door.kind} · {door.width_m.toFixed(2)} m</small>
                </button>
              </li>
            );
          })}
        </ul>
      </>}
      <p className="eyebrow section">Inside · {assets.length}</p>
      {!assets.length && <p className="muted">Nothing listed here.</p>}
      {byCategory.map(([category, items]) => (
        <div key={category} className="asset-group">
          <p className="category"><i className="swatch" style={{ background: ASSET_COLORS[category] }} />{category}</p>
          <ul>
            {items.map(asset => <li key={asset.id}><button onClick={() => onSelect({ kind: 'asset', id: asset.id })}><AssetIcon asset={asset} size={26} />{asset.name}</button></li>)}
          </ul>
        </div>
      ))}
      <p className="id">{space.id}</p>
    </aside>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  return (
    <div className={`legend ${open ? 'open' : ''}`}>
      <button onClick={() => setOpen(value => !value)}>{open ? 'Hide legend' : 'Legend'}</button>
      {open && <div className="legend-body">
        <p className="eyebrow">Spaces</p>
        {ROOM_LEGEND.map(item => <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>)}
        <p className="eyebrow">Assets</p>
        {(Object.entries(ASSET_COLORS)).map(([label, color]) => <span key={label}><i style={{ background: color }} />{humanize(label)}</span>)}
        <p className="eyebrow">Doors (Accessibility layer)</p>
        <span><i className="round" style={{ background: '#8fbf4d' }} />Step-free</span>
        <span><i className="round" style={{ background: '#e2a23a' }} />Has a step</span>
        <span><i className="round" style={{ background: '#2f8f5b' }} />Entrance</span>
      </div>}
    </div>
  );
}
