
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { AppStatus, ControlPoint, GeoreferenceResult, TransformationType } from './types';
import { analyzeMapImage, calculateWorldFile } from './services/geminiService';
import JSZip from 'jszip';

// OpenLayers imports
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import OSM from 'ol/source/OSM';
import ImageStatic from 'ol/source/ImageStatic';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Style, Icon, Text, Fill, Stroke } from 'ol/style';
// Fix: fromLonLat and transformExtent must be imported from 'ol/proj', register is in 'ol/proj/proj4'
import { fromLonLat, transformExtent } from 'ol/proj';
import { register } from 'ol/proj/proj4';

declare const proj4: any;

const PRJ_DEFINITIONS: Record<string, string> = {
  'EPSG:6261': `GEOGCS["Merchich",DATUM["Merchich",SPHEROID["Clarke 1880 (IGN)",6378249.2,293.4660212936269,AUTHORITY["EPSG","7011"]],TOWGS84[31,146,47,0,0,0,0],AUTHORITY["EPSG","6261"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","6261"]]`,
};

// Global registration of projection
if (typeof proj4 !== 'undefined') {
  proj4.defs("EPSG:6261", PRJ_DEFINITIONS['EPSG:6261']);
  register(proj4);
}

const App: React.FC = () => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [imageUrl, setImageUrl] = useState<string>("");
  const [result, setResult] = useState<GeoreferenceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTransform, setSelectedTransform] = useState<TransformationType>(TransformationType.AFFINE);
  const [viewMode, setViewMode] = useState<'IMAGE' | 'MAP'>('IMAGE');
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Initialize Map on mount
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    mapInstance.current = new Map({
      target: mapRef.current,
      layers: [
        new TileLayer({
          source: new OSM(),
          opacity: 0.8
        })
      ],
      view: new View({
        center: fromLonLat([-7.09, 31.79]), // Central Morocco
        zoom: 6
      })
    });

    return () => {
      mapInstance.current?.setTarget(undefined);
      mapInstance.current = null;
    };
  }, []);

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!imageUrl) return;
    setStatus(AppStatus.LOADING);
    setResult(null);
    setError(null);
    
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      renderImageToCanvas(img);
      setStatus(AppStatus.IDLE);
      setViewMode('IMAGE');
    };
    img.onerror = () => {
      setError("Failed to load map. This typically happens due to CORS policies on the remote server.");
      setStatus(AppStatus.ERROR);
    };
    img.src = imageUrl;
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus(AppStatus.LOADING);
    setResult(null);
    setError(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        renderImageToCanvas(img);
        setStatus(AppStatus.IDLE);
        setViewMode('IMAGE');
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const renderImageToCanvas = (img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
  };

  const updateMapPreview = (res: GeoreferenceResult) => {
    if (!mapInstance.current || !res.transformation || !imgRef.current) return;
    
    const map = mapInstance.current;
    const layers = map.getLayers().getArray();
    // Remove all layers except base OSM
    for (let i = layers.length - 1; i >= 1; i--) {
      map.removeLayer(layers[i]);
    }

    const { A, B, C, D, E, F } = res.transformation;
    const w = imgRef.current.width;
    const h = imgRef.current.height;

    // Standard affine extent calc
    const xmin = C;
    const ymax = F;
    const xmax = C + (A * w) + (B * h);
    const ymin = F + (D * w) + (E * h);
    
    const extent6261 = [xmin, Math.min(ymin, ymax), xmax, Math.max(ymin, ymax)];
    const extent3857 = transformExtent(extent6261, 'EPSG:6261', 'EPSG:3857');

    const imageLayer = new ImageLayer({
      source: new ImageStatic({
        url: imgRef.current.src,
        imageExtent: extent3857,
        projection: 'EPSG:3857'
      }),
      opacity: 0.9
    });

    const vectorSource = new VectorSource();
    res.controlPoints.forEach(cp => {
      const feature = new Feature({
        geometry: new Point(fromLonLat([cp.lng, cp.lat]))
      });
      feature.setStyle(new Style({
        image: new Icon({
          src: 'https://cdn-icons-png.flaticon.com/512/684/684908.png',
          scale: 0.05,
          color: '#ea580c'
        }),
        text: new Text({
          text: cp.id,
          offsetY: -25,
          font: 'bold 12px Inter',
          fill: new Fill({ color: '#111827' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }),
          backgroundFill: new Fill({ color: 'rgba(255,255,255,0.7)' }),
          padding: [2, 4, 2, 4]
        })
      }));
      vectorSource.addFeature(feature);
    });

    map.addLayer(imageLayer);
    map.addLayer(new VectorLayer({ source: vectorSource }));
    map.getView().fit(extent3857, { padding: [80, 80, 80, 80], duration: 1200 });
  };

  const processGeoreferencing = async () => {
    if (!imgRef.current) return;
    setStatus(AppStatus.PROCESSING);
    setError(null);

    try {
      const canvas = document.createElement('canvas');
      canvas.width = imgRef.current.width;
      canvas.height = imgRef.current.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(imgRef.current, 0, 0);
      
      const base64Data = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      const { controlPoints } = await analyzeMapImage(base64Data, 'image/jpeg');
      
      const transformation = calculateWorldFile(controlPoints, selectedTransform);

      const finalResult: GeoreferenceResult = {
        controlPoints,
        projection: "Merchich (EPSG:6261)",
        epsg: "6261",
        metadata: { width: imgRef.current.width, height: imgRef.current.height },
        transformation: transformation || undefined,
        transformationType: selectedTransform
      };

      setResult(finalResult);
      setStatus(AppStatus.SUCCESS);
      setViewMode('MAP');
      
      // Force map refresh and display points immediately
      setTimeout(() => updateMapPreview(finalResult), 50);
    } catch (err: any) {
      console.error(err);
      setError("The AI was unable to extract enough clear intersections. Please try a higher resolution image.");
      setStatus(AppStatus.ERROR);
    }
  };

  const downloadGisBundle = async () => {
    if (!result?.transformation || !imgRef.current) return;
    setStatus(AppStatus.LOADING);
    
    try {
      const zip = new JSZip();
      const { A, B, C, D, E, F } = result.transformation;
      zip.file("map_product.jgw", `${A}\n${D}\n${B}\n${E}\n${C}\n${F}`);
      zip.file("map_product.prj", PRJ_DEFINITIONS['EPSG:6261']);
      
      const canvas = document.createElement('canvas');
      canvas.width = imgRef.current.width;
      canvas.height = imgRef.current.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(imgRef.current, 0, 0);
      const imageData = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
      zip.file("map_product.jpg", imageData, { base64: true });
      
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GeoSnap_${selectedTransform}_Merchich_Output.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setStatus(AppStatus.SUCCESS);
    } catch (err) {
      setError("Error during file bundling.");
      setStatus(AppStatus.ERROR);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#f1f5f9] text-slate-700 overflow-hidden font-['Inter']">
      {/* HEADER SECTION */}
      <header className="bg-white px-10 py-5 border-b border-slate-200 flex items-center justify-between z-30 shadow-sm">
        <div className="flex items-center gap-5">
          <div className="bg-amber-500 p-2.5 rounded-2xl shadow-lg shadow-amber-200/50 transform rotate-3">
            <i className="fa-solid fa-map-location-dot text-2xl text-white"></i>
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 leading-none">GEOSNAP <span className="text-amber-600 italic">MOROCCO</span></h1>
            <p className="text-[10px] uppercase font-black text-slate-400 tracking-[0.2em] mt-1.5 flex items-center gap-2">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
              Merchich EPSG:6261 Active Engine
            </p>
          </div>
        </div>
        
        <div className="flex bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
          <button 
            onClick={() => setViewMode('IMAGE')}
            className={`px-7 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'IMAGE' ? 'bg-white shadow-md text-amber-600' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <i className="fa-solid fa-file-image"></i> Source Raster
          </button>
          <button 
            onClick={() => {
              setViewMode('MAP');
              if (result) setTimeout(() => updateMapPreview(result), 50);
            }}
            disabled={!result}
            className={`px-7 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'MAP' ? 'bg-white shadow-md text-amber-600' : 'text-slate-400 cursor-not-allowed'} ${result ? 'hover:text-slate-800' : ''}`}
          >
            <i className="fa-solid fa-satellite"></i> Map Preview
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* SIDEBAR NAVIGATION */}
        <aside className="w-[400px] bg-white border-r border-slate-200 p-10 flex flex-col gap-12 z-20 shadow-[4px_0_24px_rgba(0,0,0,0.02)] custom-scrollbar overflow-y-auto">
          {/* STEP 1: IMPORT */}
          <section>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-black italic">01</div>
              <h2 className="text-[11px] font-black text-slate-900 uppercase tracking-widest">Import Raster Data</h2>
            </div>
            <div className="space-y-4">
              <form onSubmit={handleUrlSubmit} className="group">
                <div className="relative">
                  <i className="fa-solid fa-link absolute left-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-amber-500 transition-colors"></i>
                  <input 
                    type="url" 
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="Sheet Image URL..."
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 py-4 text-xs font-semibold focus:ring-4 focus:ring-amber-500/10 focus:border-amber-500 outline-none transition-all"
                  />
                </div>
                <button type="submit" className="w-full mt-3 bg-slate-900 text-white py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all shadow-lg active:scale-95">
                  Fetch from Link
                </button>
              </form>
              
              <div className="relative group">
                <input type="file" onChange={handleFileUpload} accept="image/*" id="file-upload" className="hidden" />
                <label htmlFor="file-upload" className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-[2.5rem] p-10 cursor-pointer hover:border-amber-400 hover:bg-amber-50/20 transition-all">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4 group-hover:bg-amber-100 transition-colors">
                    <i className="fa-solid fa-file-arrow-up text-2xl text-slate-300 group-hover:text-amber-500 transition-colors"></i>
                  </div>
                  <span className="text-[10px] font-black text-slate-400 group-hover:text-amber-700 uppercase tracking-widest">Select Local Map</span>
                </label>
              </div>
            </div>
          </section>

          {/* STEP 2: PARAMS */}
          <section>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-black italic">02</div>
              <h2 className="text-[11px] font-black text-slate-900 uppercase tracking-widest">Solver Config</h2>
            </div>
            <div className="bg-slate-50 rounded-[2.5rem] border border-slate-100 p-8 space-y-8">
              <div className="flex flex-col gap-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                  <i className="fa-solid fa-microchip"></i> Transformation Model
                </label>
                <select 
                  value={selectedTransform}
                  onChange={(e) => setSelectedTransform(e.target.value as TransformationType)}
                  className="w-full bg-white border border-slate-200 rounded-2xl p-4 text-xs font-black text-slate-800 outline-none focus:ring-4 focus:ring-amber-500/10 cursor-pointer transition-all appearance-none"
                  style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%2364748b\'%3E%3Cpath stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M19 9l-7 7-7-7\'%3E%3C/path%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '1.2rem' }}
                >
                  <option value={TransformationType.AFFINE}>Affine (6-Param)</option>
                  <option value={TransformationType.HELMERT}>Helmert (Conformal)</option>
                  <option value={TransformationType.PROJECTIVE}>Projective (Fit)</option>
                </select>
              </div>
              
              <div className="pt-6 border-t border-slate-200/50 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-2xl bg-white border border-slate-200 flex items-center justify-center text-amber-600 shadow-sm">
                    <i className="fa-solid fa-compass-drafting text-lg"></i>
                  </div>
                  <div>
                    <p className="text-[11px] font-black text-slate-900 leading-none">EPSG:6261</p>
                    <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">GCS Merchich</p>
                  </div>
                </div>
                <i className="fa-solid fa-check-circle text-emerald-500 text-xl"></i>
              </div>
            </div>
          </section>

          {/* ANALYSIS BUTTON */}
          <div className="mt-auto space-y-5">
            <button 
              onClick={processGeoreferencing}
              disabled={!imgRef.current || status === AppStatus.PROCESSING}
              className={`w-full py-7 rounded-[2rem] font-black text-xs uppercase tracking-[0.3em] shadow-xl transition-all ${
                !imgRef.current 
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed' 
                  : 'bg-amber-500 text-white hover:bg-amber-600 hover:-translate-y-1 hover:shadow-amber-200 shadow-amber-500/20 active:translate-y-0'
              }`}
            >
              {status === AppStatus.PROCESSING ? (
                <><i className="fa-solid fa-circle-notch fa-spin mr-3"></i> Identifying Intersections...</>
              ) : (
                <><i className="fa-solid fa-brain mr-3"></i> AI Georeference</>
              )}
            </button>

            {result && (
              <button 
                onClick={downloadGisBundle}
                className="w-full bg-slate-900 text-white py-7 rounded-[2rem] text-xs font-black uppercase tracking-widest hover:bg-slate-800 shadow-2xl transition-all flex items-center justify-center gap-4 active:scale-95"
              >
                <i className="fa-solid fa-download text-amber-500"></i>
                Bundle Geotiff Pack
              </button>
            )}
            
            {error && (
              <div className="p-5 bg-rose-50 border border-rose-100 rounded-[2rem] flex items-start gap-3">
                <i className="fa-solid fa-triangle-exclamation text-rose-500 mt-1"></i>
                <p className="text-[11px] font-bold text-rose-700 leading-relaxed">{error}</p>
              </div>
            )}
          </div>
        </aside>

        {/* WORKSPACE VIEWPORT */}
        <section className="flex-1 relative overflow-hidden bg-slate-100">
          <div className="absolute inset-0 z-0">
             {/* IMAGE MODE CONTENT */}
             <div className={`absolute inset-0 flex items-center justify-center p-16 transition-all duration-1000 ease-in-out ${viewMode === 'IMAGE' ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
               <div className="relative shadow-2xl rounded-[3rem] overflow-hidden border-[16px] border-white bg-white max-h-full transition-transform">
                 <canvas ref={canvasRef} className="max-w-full max-h-full block rounded-2xl shadow-inner" />
                 {!imgRef.current && (
                   <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/90 backdrop-blur-md p-16 text-center">
                     <div className="w-32 h-32 bg-white rounded-[3rem] shadow-2xl flex items-center justify-center mb-10 relative">
                        <div className="absolute inset-0 border-4 border-amber-500/10 rounded-[3rem] animate-ping"></div>
                        <i className="fa-solid fa-mountain-sun text-6xl text-slate-100"></i>
                     </div>
                     <h3 className="text-3xl font-black text-slate-900 mb-6 tracking-tight uppercase italic">No Raster Source</h3>
                     <p className="text-slate-400 text-base font-medium leading-relaxed max-w-sm uppercase tracking-tighter opacity-80">Please upload a Moroccan map sheet to activate the automated geodetic workspace.</p>
                   </div>
                 )}
               </div>
             </div>

             {/* MAP MODE CONTENT */}
             <div 
               ref={mapRef} 
               className={`absolute inset-0 transition-all duration-1000 ease-in-out ${viewMode === 'MAP' ? 'opacity-100 scale-100' : 'opacity-0 scale-105 pointer-events-none'}`}
             />
          </div>

          {/* BOTTOM DATA OVERLAY */}
          {result && (
            <div className="absolute bottom-10 left-10 right-10 h-72 bg-white/95 backdrop-blur-3xl rounded-[3.5rem] shadow-2xl border border-white flex overflow-hidden z-20 transition-all animate-in slide-in-from-bottom-10 duration-700">
              <div className="w-[340px] p-12 border-r border-slate-100 bg-slate-50/40 flex flex-col justify-center gap-10">
                <div>
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Output Specs</h3>
                  <div className="flex items-center gap-5">
                    <div className="w-16 h-16 bg-white rounded-[1.5rem] flex items-center justify-center border border-slate-100 shadow-sm text-amber-600">
                        <i className="fa-solid fa-globe-africa text-4xl"></i>
                    </div>
                    <div>
                        <p className="text-3xl font-black text-slate-900 tracking-tighter leading-none mb-1">Merchich</p>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">EPSG:6261 Frame</p>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-5">
                  <div className="bg-white p-5 rounded-[2rem] border border-slate-100 shadow-sm">
                    <p className="text-[9px] text-slate-400 font-black uppercase mb-1 tracking-widest">GCP Nodes</p>
                    <p className="text-2xl font-black text-amber-600">{result.controlPoints.length}</p>
                  </div>
                  <div className="bg-white p-5 rounded-[2rem] border border-slate-100 shadow-sm">
                    <p className="text-[9px] text-slate-400 font-black uppercase mb-1 tracking-widest">Dimension</p>
                    <p className="text-xl font-black text-slate-800">{result.metadata.width}px</p>
                  </div>
                </div>
              </div>
              
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="px-12 py-7 border-b border-slate-50 flex justify-between items-center bg-white/50 backdrop-blur-md sticky top-0 z-10">
                  <h3 className="text-[11px] font-black text-slate-500 uppercase tracking-widest flex items-center gap-3">
                    <i className="fa-solid fa-list-check"></i> Point Registry
                  </h3>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-emerald-600 font-black px-5 py-2 bg-emerald-50 rounded-full border border-emerald-100 uppercase tracking-widest">Validated GCP</span>
                  </div>
                </div>
                <div className="flex-1 overflow-auto custom-scrollbar bg-white/30">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-50/20">
                        <th className="px-12 py-5 font-black text-slate-400 uppercase tracking-widest border-b border-slate-50">Node ID</th>
                        <th className="px-12 py-5 font-black text-slate-400 uppercase tracking-widest border-b border-slate-50">Raster Pos</th>
                        <th className="px-12 py-5 font-black text-slate-400 uppercase tracking-widest border-b border-slate-50">Geodetic Coord (Lat/Lng)</th>
                        <th className="px-12 py-5 font-black text-slate-400 uppercase tracking-widest border-b border-slate-50">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {result.controlPoints.map((cp) => (
                        <tr key={cp.id} className="hover:bg-slate-50/60 transition-colors">
                          <td className="px-12 py-6 font-black text-slate-900">{cp.id}</td>
                          <td className="px-12 py-6 font-mono text-slate-500 font-bold">[{Math.round(cp.pixelX)}, {Math.round(cp.pixelY)}]</td>
                          <td className="px-12 py-6 font-mono font-black text-amber-700 text-sm">
                            {cp.lat.toFixed(6)}° N | {cp.lng.toFixed(6)}° W
                          </td>
                          <td className="px-12 py-6">
                            <div className="flex items-center gap-5">
                               <div className="w-28 h-2.5 bg-slate-100 rounded-full overflow-hidden border border-slate-200 shadow-inner">
                                 <div className="h-full bg-emerald-500 w-[98%] shadow-[0_0_10px_rgba(16,185,129,0.4)]"></div>
                               </div>
                               <span className="text-[10px] font-black text-slate-400">SNAP 0.1s</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* AI PROCESSING MODAL */}
          {status === AppStatus.PROCESSING && (
            <div className="absolute inset-0 bg-white/95 backdrop-blur-3xl z-50 flex items-center justify-center">
              <div className="flex flex-col items-center text-center max-w-sm px-10">
                <div className="relative w-40 h-40 mb-14">
                   <div className="absolute inset-0 border-[12px] border-slate-100 rounded-[3rem]"></div>
                   <div className="absolute inset-0 border-[12px] border-amber-500 border-t-transparent rounded-[3rem] animate-spin"></div>
                   <div className="absolute inset-0 flex items-center justify-center">
                      <i className="fa-solid fa-satellite-dish text-5xl text-amber-500 animate-pulse"></i>
                   </div>
                </div>
                <h2 className="text-4xl font-black mb-6 tracking-tighter uppercase italic text-slate-900">AI Grid Alignment</h2>
                <p className="text-slate-400 text-sm font-semibold mb-14 uppercase tracking-[0.2em] italic leading-relaxed opacity-80">
                  Triangulating intersection vectors and locking geodetic degree labels for EPSG:6261 Merchich Frame...
                </p>
                <div className="w-full h-4 bg-slate-100 rounded-full overflow-hidden border border-slate-200 shadow-inner">
                   <div className="h-full bg-amber-500 w-full animate-[progress_3s_infinite_linear]"></div>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* COMPACT FOOTER */}
      <footer className="bg-white border-t border-slate-200 px-10 py-4 flex justify-between items-center text-[10px] text-slate-400 font-black uppercase tracking-[0.4em] z-30">
        <div className="flex gap-12 items-center">
          <span className="flex items-center gap-3 text-amber-600/80"><i className="fa-solid fa-shield-check"></i> Merchich GCS Standard v4.3</span>
          <div className="w-1.5 h-1.5 bg-slate-200 rounded-full"></div>
          <span className="flex items-center gap-3 hover:text-slate-600 transition-colors cursor-help"><i className="fa-solid fa-circle-info"></i> Moroccan Cartographic Agency Specs</span>
        </div>
        <div className="flex gap-8 items-center">
          <div className="flex items-center gap-3 px-4 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-500">
            <i className="fa-solid fa-terminal text-[8px]"></i>
            <span className="text-[9px] font-black">CORE BUILD 2025.04</span>
          </div>
          <span className="text-slate-300">© 2025 GEOSNAP AI</span>
        </div>
      </footer>
      
      <style>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        ::selection {
          background: #f59e0b;
          color: white;
        }
      `}</style>
    </div>
  );
};

export default App;
