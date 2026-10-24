'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { demoBuilding as building } from '@/lib/buildings/demo';

type Match = { id: string; name: string; space_id?: string };
export function BuildingWorkspace() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('0.04');
  const [results, setResults] = useState<Match[]>([]);
  const [status, setStatus] = useState('Try a room number or equipment name.');
  const [busy, setBusy] = useState(false);
  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Search failed.');
      setResults(data.matches);
      setStatus(data.matches.length ? `${data.matches.length} match${data.matches.length === 1 ? '' : 'es'} found. Select one to locate it.` : 'No matches. Try “printer”, “coffee”, or “0.03”.');
      if (data.matches.length === 1) setSelected(data.matches[0].space_id ?? data.matches[0].id);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Search unavailable. Try again.');
      setResults([]);
    } finally { setBusy(false); }
  }
  const space = building.spaces.find(item => item.id === selected)!;
  return <main>
    <header className="topbar"><Link className="brand" href="/">◈ <span>lost & found</span></Link><span className="badge">TEAM WORKSPACE <span className="dot" /></span></header>
    <section className="intro"><p className="eyebrow">A LITTLE LESS LOST.</p><h1>Know your way around.</h1><p>Your building, its spaces, and everything inside. Start exploring.</p></section>
    <div className="workspace">
      <aside className="panel search-panel"><div className="panel-heading"><span className="eyebrow">01 / FIND SOMETHING</span><span>↗</span></div><h2>What are you looking for?</h2><p className="muted">Search the demo building’s rooms and equipment.</p>
        <form onSubmit={search}><label htmlFor="search">Room or equipment</label><div className="search-row"><input id="search" maxLength={200} required value={query} onChange={event => setQuery(event.target.value)} placeholder="e.g. 3D printer" /><button disabled={busy} type="submit" aria-label="Search building">{busy ? '…' : '→'}</button></div></form>
        <div className="suggestions">{['printer','CNC','coffee'].map(term => <button key={term} onClick={() => setQuery(term)}>{term} ↗</button>)}</div>
        <p className="status" role="status">{status}</p>
        <div className="results">{results.map(result => <button key={result.id} onClick={() => setSelected(result.space_id ?? result.id)}>{result.name}<span>↗</span></button>)}</div>
        <div className="demo-note"><span className="dot" /> Demo mode<h3>A foundation to build on.</h3><p>Local sample data and working search. Conversational AI, routing, and plan import are next.</p></div>
      </aside>
      <section className="panel map-panel" aria-label="Building floor plan"><div className="map-heading"><div><p className="eyebrow">02 / EXPLORE THE BUILDING</p><h2>{building.building.name}</h2></div><span className="floor-tag">G / Ground floor</span></div>
        <div className="map-canvas"><svg viewBox="-2 -2 30 24" role="img" aria-labelledby="map-title"><title id="map-title">Ground floor of Workshop One. Select a room below to highlight it.</title><g transform="translate(0 20) scale(1 -1)">{building.spaces.map(room => <polygon key={room.id} points={room.polygon.map(point => point.join(',')).join(' ')} fill={room.id === selected ? '#d8f578' : room.type === 'corridor' ? '#e4e7df' : '#f9faf6'} stroke="#66725e" strokeWidth=".12" />)}{building.openings.map(door => <circle key={door.id} cx={door.position[0]} cy={door.position[1]} r=".24" fill="#58684c" />)}</g>{building.spaces.filter(room => room.type !== 'corridor').map(room => { const x = (room.polygon[0][0]+room.polygon[2][0])/2; const y = 20-(room.polygon[0][1]+room.polygon[2][1])/2; return <text key={room.id} x={x} y={y} textAnchor="middle" fontSize=".56" fill="#273322">{room.name}<tspan x={x} dy="1" fontSize=".43" fill="#65715b">{room.ref}</tspan></text>; })}</svg></div>
        <div className="map-footer"><span><i /> Selected space</span><span>Original sample · metres · Y up</span></div>
      </section>
      <section className="panel detail-panel"><p className="eyebrow">03 / SPACE DETAILS</p><h2>{space.name}</h2><p className="muted">Ground floor · Room {space.ref}</p><hr /><p className="eyebrow">INSIDE THIS SPACE</p>{building.assets.filter(asset => asset.space_id === selected).map(asset => <div className="asset" key={asset.id}><span>◇</span><div><strong>{asset.name}</strong><p>{asset.category}</p></div></div>)}{!building.assets.some(asset => asset.space_id === selected) && <p className="muted">No equipment listed.</p>}<label htmlFor="room-picker">Explore another space</label><select id="room-picker" value={selected} onChange={event => setSelected(event.target.value)}>{building.spaces.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}</select><div className="next-step"><p className="eyebrow">NEXT MILESTONE</p><p>Connect the routing engine to turn a location into a journey.</p></div></section>
    </div><footer className="page-footer"><span>INDUSTRIAL AGENTS HACKATHON / 2026</span><span>One floor. One working flow. Then scale.</span></footer>
  </main>;
}
