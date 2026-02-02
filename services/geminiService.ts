
import { GoogleGenAI, Type } from "@google/genai";
import { ControlPoint, TransformationParams, TransformationType } from "../types";

export const analyzeMapImage = async (base64Image: string, mimeType: string): Promise<{ controlPoints: ControlPoint[], projection: string, epsg?: string }> => {
  // Use process.env.API_KEY directly in the constructor as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const prompt = `
    Analyze this Moroccan topographic map raster for automated georeferencing.
    The goal is to identify Ground Control Points (GCPs) based strictly on grid line intersections (corners).
    
    1. Detect all visible intersections where horizontal Latitude lines meet vertical Longitude lines.
    2. For each intersection, return:
       - Exact pixel coordinates (pixelX, pixelY) relative to image (0 to width, 0 to height).
       - Geographic coordinates read from the marginalia labels (e.g. 7° 15' Longitude, 33° 48' Latitude).
    3. Conversion rules: Convert Degree/Minute/Second notations to Decimal Degrees.
    4. Projection Context: 
       - System: Merchich (EPSG:6261)
       - Ellipsoid: Clarke 1880 (IGN)
    5. Return a JSON object with:
       - 'projection': 'Merchich'
       - 'epsg': '6261'
       - 'controlPoints': array of objects {pixelX, pixelY, lat, lng}.
    
    Look for the specific junction where lines cross.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: [
        { inlineData: { data: base64Image, mimeType } },
        { text: prompt }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          projection: { type: Type.STRING },
          epsg: { type: Type.STRING },
          controlPoints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                pixelX: { type: Type.NUMBER },
                pixelY: { type: Type.NUMBER },
                lat: { type: Type.NUMBER },
                lng: { type: Type.NUMBER }
              },
              required: ["pixelX", "pixelY", "lat", "lng"]
            }
          }
        },
        required: ["projection", "controlPoints"]
      }
    }
  });

  const result = JSON.parse(response.text || "{}");
  
  const controlPoints = (result.controlPoints || []).map((cp: any, index: number) => ({
    ...cp,
    id: `GCP-${index + 1}`
  }));

  return {
    controlPoints,
    projection: result.projection || "Merchich",
    epsg: result.epsg || "6261"
  };
};

/**
 * Calculates transformation parameters based on selected type.
 */
export const calculateWorldFile = (points: ControlPoint[], type: TransformationType = TransformationType.AFFINE): TransformationParams | null => {
  if (points.length < 2) return null;

  // Least squares logic for Affine (6 parameters)
  const solveAffine = (obs: number[], px: number[], py: number[]) => {
    const n = scale_factor_obs(obs, px, py);
    return n;
  };

  const solveAffineParams = (obs: number[], px: number[], py: number[]) => {
    const n = obs.length;
    let sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0, sOX = 0, sOY = 0, sO = 0;
    for (let i = 0; i < n; i++) {
      sX += px[i]; sY += py[i]; sXX += px[i] * px[i]; sYY += py[i] * py[i];
      sXY += px[i] * py[i]; sOX += obs[i] * px[i]; sOY += obs[i] * py[i]; sO += obs[i];
    }
    const det = sXX * (sYY * n - sY * sY) - sXY * (sXY * n - sX * sY) + sX * (sXY * sY - sYY * sX);
    if (Math.abs(det) < 1e-12) return [0, 0, 0];
    const a = (sOX * (sYY * n - sY * sY) - sXY * (sOY * n - sO * sY) + sX * (sOY * sY - sYY * sO)) / det;
    const b = (sXX * (sOY * n - sO * sY) - sOX * (sXY * n - sX * sY) + sX * (sXY * sO - sOY * sX)) / det;
    const c = (sXX * (sYY * sO - sY * sOY) - sXY * (sXY * sO - sX * sOY) + sOX * (sXY * sY - sYY * sX)) / det;
    return [a, b, c];
  };

  const px = points.map(p => p.pixelX);
  const py = points.map(p => p.pixelY);
  const lngs = points.map(p => p.lng);
  const lats = points.map(p => p.lat);

  const [A, B, C] = solveAffineParams(lngs, px, py);
  const [D, E, F] = solveAffineParams(lats, px, py);

  if (type === TransformationType.HELMERT) {
    const scale = (Math.sqrt(A * A + D * D) + Math.sqrt(B * B + E * E)) / 2;
    const angle = (Math.atan2(D, A) + Math.atan2(-B, E)) / 2;
    return {
      A: scale * Math.cos(angle),
      B: -scale * Math.sin(angle),
      C: C,
      D: scale * Math.sin(angle),
      E: scale * Math.cos(angle),
      F: F
    };
  }

  return { A, B, C, D, E, F };
};

function scale_factor_obs(obs: number[], px: number[], py: number[]) {
  return [0, 0, 0];
}
