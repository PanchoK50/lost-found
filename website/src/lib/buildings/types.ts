/** Core fields from Synera's building.json. Coordinates are metres, Y points up. */
export type Point = [number, number];
export interface Space {
  id: string;
  floor_id: string;
  type: 'room' | 'corridor' | 'stair' | 'lift' | 'hall' | 'outdoor';
  room_type: string;
  name: string;
  ref: string;
  polygon: Point[];
  synthetic: boolean;
}
export interface Floor { id: string; level: number; name: string; elevation_m: number; height_m: number }
export interface Opening { id: string; floor_id: string; space_ids: [string, string]; kind: 'door' | 'opening' | 'entrance'; position: Point; width_m: number; step_free: boolean; synthetic: boolean }
export interface VerticalConnector { id: string; kind: 'stairs' | 'lift'; name: string; floor_ids: string[]; space_ids: string[]; step_free: boolean; synthetic: boolean }
export interface Asset { id: string; name: string; category: 'furniture' | 'fixture' | 'machine' | 'equipment'; type: string; space_id: string; floor_id: string; position: Point; footprint?: { width_m: number; depth_m: number; rotation_deg: number }; source: string }
export interface Building {
  building: { id: string; name: string; units: 'm'; source: string; license: string; attribution: string };
  floors: Floor[];
  spaces: Space[];
  openings: Opening[];
  vertical_connectors: VerticalConnector[];
  assets: Asset[];
}
