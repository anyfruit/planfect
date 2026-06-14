// Maps abstraction — geocoding + commute ETA used by the planner's geocode_place /
// estimate_commute tools. Default impl is Apple Maps Server API; Google / Amap (China)
// drop in behind the same interface. See docs/DECISIONS.md ADR-006.

import { type TransportMode } from '../types.ts';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeocodeResult {
  name: string;
  address: string;
  lat: number;
  lng: number;
  placeId?: string;
}

export interface RouteEstimate {
  mode: TransportMode;
  durationMin: number;
  distanceM: number;
}

export interface MapsProvider {
  geocode(query: string): Promise<GeocodeResult | null>;
  directions(from: GeoPoint, to: GeoPoint, modes: TransportMode[]): Promise<RouteEstimate[]>;
}

/** Deterministic stub for tests/dev (no network). */
export class MockMapsProvider implements MapsProvider {
  async geocode(query: string): Promise<GeocodeResult | null> {
    return { name: query, address: query, lat: 0, lng: 0, placeId: `mock:${query}` };
  }
  async directions(_from: GeoPoint, _to: GeoPoint, modes: TransportMode[]): Promise<RouteEstimate[]> {
    return modes.map((mode) => ({ mode, durationMin: 20, distanceM: 5000 }));
  }
}
