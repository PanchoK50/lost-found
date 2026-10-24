import type { Building, Space } from './types';

function room(id: string, name: string, room_type: string, x: number, y: number, w: number, h: number): Space {
  return { id, name, ref: id, room_type, floor_id: 'F0', type: room_type === 'corridor' ? 'corridor' : 'room', polygon: [[x,y],[x+w,y],[x+w,y+h],[x,y+h]], synthetic: true };
}
/** Original fixture. No challenge dataset or third-party floor plans are bundled. */
export const demoBuilding: Building = {
  building: { id: 'team-demo', name: 'Workshop One', units: 'm', source: 'team demo', license: 'CC0-1.0', attribution: 'Original synthetic starter fixture' },
  floors: [{ id: 'F0', name: 'Ground floor', level: 0, elevation_m: 0, height_m: 4 }],
  spaces: [room('0.01','Lobby','lobby',0,0,8,6),room('0.02','Main corridor','corridor',8,0,4,20),room('0.03','Machine shop','production_zone',12,0,14,10),room('0.04','Print lab','makerspace',12,10,14,10),room('0.05','Meeting room','meeting_room',0,6,8,8),room('0.06','Coffee kitchen','kitchen',0,14,8,6)],
  openings: [
    { id: 'entrance', floor_id: 'F0', space_ids: ['outside','0.01'], kind: 'entrance', position: [4,0], width_m: 1.6, step_free: true, synthetic: true },
    ...(['0.01','0.03','0.04','0.05','0.06'] as const).map((id,i) => ({ id: `door-${id}`, floor_id: 'F0', space_ids: [id,'0.02'] as [string,string], kind: 'door' as const, position: [[8,3],[12,5],[12,15],[8,10],[8,17]][i] as [number,number], width_m: 1.2, step_free: true, synthetic: true })),
  ],
  vertical_connectors: [],
  assets: [
    { id: 'cnc', name: 'CNC mill', category: 'machine', type: 'cnc_mill', space_id: '0.03', floor_id: 'F0', position: [19,5], source: 'generated' },
    { id: 'printer', name: '3D printer', category: 'equipment', type: '3d_printer', space_id: '0.04', floor_id: 'F0', position: [19,15], source: 'generated' },
    { id: 'coffee', name: 'Coffee machine', category: 'equipment', type: 'coffee_machine', space_id: '0.06', floor_id: 'F0', position: [4,17], source: 'generated' },
  ],
};
