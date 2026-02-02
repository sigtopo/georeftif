
export interface ControlPoint {
  id: string;
  pixelX: number;
  pixelY: number;
  lat: number;
  lng: number;
  label?: string;
}

export interface TransformationParams {
  A: number; // x-scale
  B: number; // rotation y
  C: number; // translation x
  D: number; // rotation x
  E: number; // y-scale (usually negative)
  F: number; // translation y
}

export enum TransformationType {
  AFFINE = 'AFFINE',
  HELMERT = 'HELMERT',
  PROJECTIVE = 'PROJECTIVE' // Note: Projective is approximated in World Files
}

export interface GeoreferenceResult {
  controlPoints: ControlPoint[];
  projection: string;
  epsg?: string;
  metadata: {
    width: number;
    height: number;
    description?: string;
  };
  transformation?: TransformationParams;
  transformationType: TransformationType;
}

export enum AppStatus {
  IDLE = 'IDLE',
  LOADING = 'LOADING',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR'
}
