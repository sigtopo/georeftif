
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
import Polygon, { fromExtent } from 'ol/geom/Polygon';
import { Style, Icon, Text, Fill, Stroke, RegularShape } from 'ol/style';
import { fromLonLat, transformExtent } from 'ol/proj';
import { register } from 'ol/proj/proj4';
import Select from 'ol/interaction/Select';
import { click } from 'ol/events/condition';

declare const proj4: any;

const PRJ_DEFINITIONS: Record<string, string> = {
  'EPSG:6261': `GEOGCS["Merchich",DATUM["Merchich",SPHEROID["Clarke 1880 (IGN)",6378249.2,293.4660212936269,AUTHORITY["EPSG","7011"]],TOWGS84[31,146,47,0,0,0,0],AUTHORITY["EPSG","6261"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","6261"]]`,
};

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
  const [tableState, setTableState] = useState<'HIDDEN' | 'MINIMIZED' | 'EXPANDED'>('HIDDEN');
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Responsive sidebar handling
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(true);
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    mapInstance.current = new Map({
      target: mapRef.current,
      layers: [
        new TileLayer({
          source: new OSM(),
          opacity: 0.7
        })
      ],
      view: new View({
        center: fromLonLat([-7.09, 31.79]),
        zoom: 6
      })
    });

    const selectInteraction = new Select({
      condition: click,
      style: null 
    });

    selectInteraction.on('select', (e) => {
      const feature = e.selected[0];
      if (feature && feature.get('type') === 'bbox') {
        downloadGeoJSON(feature as Feature<Polygon>);
      }
    });

    mapInstance.current.addInteraction(selectInteraction);

    return () => {
      mapInstance.current?.setTarget(undefined);
      mapInstance.current = null;
    };
  }, []);

  const downloadGeoJSON = (feature: Feature<Polygon>) => {
    if (!result) return;
    
    const geojson = {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { name: "Map Bounding Box", system: "EPSG:6261" },
        geometry: {
          type: "Polygon",
          coordinates: [
            result.controlPoints.map(p => [p.lng, p.lat])
          ]
        }
      }]
    };

    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "boundary.geojson";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadGCPFile = () => {
    if (!result) return;
    const gcpContent = result.controlPoints
      .map(p => `${p.pixelX} ${p.pixelY} ${p.lng} ${p.lat}`)
      .join('\n');
    
    const blob = new Blob([gcpContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "control_points.gcp";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!imageUrl) return;
    setStatus(AppStatus.LOADING);
    setResult(null);
    setError(null);
    setTableState('HIDDEN');
    
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      renderImageToCanvas(img);
      setStatus(AppStatus.IDLE);
      setViewMode('IMAGE');
      if (window.innerWidth < 768) setIsSidebarOpen(false);
    };
    img.onerror = () => {
      setError("فشل تحميل الصورة. قد يكون السبب سياسة CORS للموقع المصدر.");
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
    setTableState('HIDDEN');

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        renderImageToCanvas(img);
        setStatus(AppStatus.IDLE);
        setViewMode('IMAGE');
        if (window.innerWidth < 768) setIsSidebarOpen(false);
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
    for (let i = layers.length - 1; i >= 1; i--) {
      map.removeLayer(layers[i]);
    }

    const { A, B, C, D, E, F } = res.transformation;
    const w = imgRef.current.width;
    const h = imgRef.current.height;

    const c1 = [C, F];
    const c2 = [A * w + C, D * w + F];
    const c3 = [A * w + B * h + C, D * w + E * h + F];
    const c4 = [B * h + C, E * h + F];

    const xCoords = [c1[0], c2[0], c3[0], c4[0]];
    const yCoords = [c1[1], c2[1], c3[1], c4[1]];

    const extent6261 = [
      Math.min(...xCoords),
      Math.min(...yCoords),
      Math.max(...xCoords),
      Math.max(...yCoords)
    ];

    const extent3857 = transformExtent(extent6261, 'EPSG:6261', 'EPSG:3857');

    const imageLayer = new ImageLayer({
      source: new ImageStatic({
        url: imgRef.current.src,
        imageExtent: extent3857,
        projection: 'EPSG:3857'
      }),
      opacity: 0.8
    });

    const vectorSource = new VectorSource();
    
    const bboxFeature = new Feature({
      geometry: fromExtent(extent3857),
      type: 'bbox'
    });
    bboxFeature.setStyle(new Style({
      stroke: new Stroke({ color: '#ea580c', width: 3, lineDash: [8, 8] }),
      fill: new Fill({ color: 'rgba(234, 88, 12, 0.05)' })
    }));
    vectorSource.addFeature(bboxFeature);

    res.controlPoints.forEach(cp => {
      const feature = new Feature({
        geometry: new Point(fromLonLat([cp.lng, cp.lat]))
      });

      feature.setStyle(new Style({
        image: new RegularShape({
          fill: new Fill({ color: 'rgba(234, 88, 12, 0.6)' }),
          stroke: new Stroke({ color: '#ea580c', width: 2 }),
          points: 4,
          radius: 12,
          angle: Math.PI / 4,
        }),
        text: new Text({
          text: cp.id,
          offsetY: -22,
          font: '900 12px Inter',
          fill: new Fill({ color: '#ffffff' }),
          stroke: new Stroke({ color: '#1e293b', width: 3 }),
          backgroundFill: new Fill({ color: 'rgba(15, 23, 42, 0.8)' }),
          padding: [4, 8, 4, 8]
        })
      }));
      
      const featureCross = new Feature({
        geometry: new Point(fromLonLat([cp.lng, cp.lat]))
      });
      featureCross.setStyle(new Style({
        image: new RegularShape({
          stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
          points: 4,
          radius: 20,
          radius2: 0,
          angle: 0
        })
      }));

      vectorSource.addFeature(feature);
      vectorSource.addFeature(featureCross);
    });

    map.addLayer(imageLayer);
    map.addLayer(new VectorLayer({ source: vectorSource }));
    map.getView().fit(extent3857, { padding: [150, 150, 150, 150], duration: 1500 });
  };

  const processGeoreferencing = async () => {
    if (!imgRef.current) return;
    setStatus(AppStatus.PROCESSING);
    setError(null);
    setTableState('HIDDEN');

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
      setTableState('MINIMIZED');
      
      setTimeout(() => updateMapPreview(finalResult), 100);
      if (window.innerWidth < 768) setIsSidebarOpen(false);
    } catch (err: any) {
      console.error(err);
      setError("فشل تحليل الذكاء الاصطناعي. لم يتم التعرف على تقاطعات كافية بدقة.");
      setStatus(AppStatus.ERROR);
    }
  };

  const downloadGisBundle = async () => {
    if (!result?.transformation || !imgRef.current) return;
    setStatus(AppStatus.LOADING);
    
    try {
      const zip = new JSZip();
      const { A, B, C, D, E, F } = result.transformation;
      zip.file("raster_map.jgw", `${A}\n${D}\n${B}\n${E}\n${C}\n${F}`);
      zip.file("raster_map.prj", PRJ_DEFINITIONS['EPSG:6261']);
      
      const gcpText = result.controlPoints.map(p => `${p.pixelX} ${p.pixelY} ${p.lng} ${p.lat}`).join('\n');
      zip.file("raster_map.gcp", gcpText);

      const geojson = {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: { name: "Extent" },
          geometry: {
            type: "Polygon",
            coordinates: [result.controlPoints.map(p => [p.lng, p.lat])]
          }
        }]
      };
      zip.file("boundary.geojson", JSON.stringify(geojson));
      
      const canvas = document.createElement('canvas');
      canvas.width = imgRef.current.width;
      canvas.height = imgRef.current.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(imgRef.current, 0, 0);
      const imageData = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
      zip.file("raster_map.jpg", imageData, { base64: true });
      
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GeoSnap_GIS_Bundle_${selectedTransform}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setStatus(AppStatus.SUCCESS);
    } catch (err) {
      setError("حدث خطأ أثناء تجميع الملفات.");
      setStatus(AppStatus.ERROR);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#f1f5f9] text-slate-700 overflow-hidden font-['Inter'] relative">
      {/* HEADER SECTION */}
      <header className="bg-white px-4 md:px-10 py-3 md:py-5 border-b border-slate-200 flex items-center justify-between z-30 shadow-sm shrink-0">
        <div className="flex items-center gap-3 md:gap-5">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="md:hidden p-2 rounded-lg hover:bg-slate-100 text-slate-600 transition-colors"
          >
            <i className={`fa-solid ${isSidebarOpen ? 'fa-xmark' : 'fa-bars'} text-xl`}></i>
          </button>
          <div className="bg-amber-600 p-2 md:p-2.5 rounded-xl md:rounded-2xl shadow-lg shadow-amber-200/50 transform rotate-3">
            <i className="fa-solid fa-map-location-dot text-lg md:text-2xl text-white"></i>
          </div>
          <div className="hidden sm:block">
            <h1 className="text-xl md:text-2xl font-black tracking-tight text-slate-900 leading-none">GEOSNAP <span className="text-amber-600 italic">AI</span></h1>
            <p className="text-[8px] md:text-[10px] uppercase font-black text-slate-400 tracking-[0.2em] mt-1 flex items-center gap-2">
              <span className="w-1.5 md:w-2 h-1.5 md:h-2 bg-emerald-500 rounded-full animate-pulse"></span>
              نظام الإسناد الآلي EPSG:6261
            </p>
          </div>
        </div>
        
        <div className="flex bg-slate-100 p-1 rounded-xl md:rounded-2xl border border-slate-200 scale-90 md:scale-100">
          <button 
            onClick={() => { setViewMode('IMAGE'); if (window.innerWidth < 768) setIsSidebarOpen(false); }}
            className={`px-4 md:px-7 py-1.5 md:py-2.5 rounded-lg md:rounded-xl text-[10px] md:text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'IMAGE' ? 'bg-white shadow-md text-amber-600' : 'text-slate-500'}`}
          >
            <i className="fa-solid fa-file-image"></i> <span className="hidden xs:inline">Raster</span>
          </button>
          <button 
            onClick={() => {
              setViewMode('MAP');
              if (result) setTimeout(() => updateMapPreview(result), 50);
              if (window.innerWidth < 768) setIsSidebarOpen(false);
            }}
            disabled={!result}
            className={`px-4 md:px-7 py-1.5 md:py-2.5 rounded-lg md:rounded-xl text-[10px] md:text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'MAP' ? 'bg-white shadow-md text-amber-600' : 'text-slate-400 cursor-not-allowed'}`}
          >
            <i className="fa-solid fa-satellite"></i> <span className="hidden xs:inline">Preview</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden relative">
        {/* SIDEBAR NAVIGATION - Responsive */}
        <aside className={`
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          fixed md:relative md:translate-x-0
          w-[280px] sm:w-[350px] md:w-[400px] 
          h-[calc(100vh-64px)] md:h-full
          bg-white border-r border-slate-200 p-6 md:p-10 
          flex flex-col gap-8 md:gap-12 z-40 
          shadow-2xl md:shadow-none 
          transition-transform duration-300 ease-in-out
          custom-scrollbar overflow-y-auto
        `}>
          <section>
            <div className="flex items-center gap-4 mb-4 md:mb-6">
              <div className="w-7 h-7 md:w-8 md:h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px] md:text-xs font-black italic">01</div>
              <h2 className="text-[10px] md:text-[11px] font-black text-slate-900 uppercase tracking-widest">تحميل الخريطة</h2>
            </div>
            <div className="space-y-4">
              <form onSubmit={handleUrlSubmit} className="group">
                <div className="relative">
                  <i className="fa-solid fa-link absolute left-4 top-1/2 -translate-y-1/2 text-slate-300"></i>
                  <input 
                    type="url" 
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="رابط الصورة (JPG/PNG)..."
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl md:rounded-2xl pl-12 pr-4 py-3 md:py-4 text-xs font-semibold focus:ring-4 focus:ring-amber-500/10 focus:border-amber-600 outline-none transition-all"
                  />
                </div>
                <button type="submit" className="w-full mt-2 md:mt-3 bg-slate-900 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all active:scale-95">
                  جلب من الرابط
                </button>
              </form>
              <div className="relative group">
                <input type="file" onChange={handleFileUpload} accept="image/*" id="file-upload" className="hidden" />
                <label htmlFor="file-upload" className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-2xl md:rounded-[2.5rem] p-6 md:p-10 cursor-pointer hover:border-amber-500 hover:bg-amber-50/20 transition-all">
                  <div className="w-12 h-12 md:w-16 md:h-16 bg-slate-50 rounded-full flex items-center justify-center mb-3 md:mb-4 group-hover:bg-amber-100 transition-colors">
                    <i className="fa-solid fa-upload text-xl md:text-2xl text-slate-300 group-hover:text-amber-600"></i>
                  </div>
                  <span className="text-[8px] md:text-[10px] font-black text-slate-400 group-hover:text-amber-700 uppercase tracking-widest">رفع ملف محلي</span>
                </label>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-4 mb-4 md:mb-6">
              <div className="w-7 h-7 md:w-8 md:h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px] md:text-xs font-black italic">02</div>
              <h2 className="text-[10px] md:text-[11px] font-black text-slate-900 uppercase tracking-widest">إعدادات المعالجة</h2>
            </div>
            <div className="bg-slate-50 rounded-2xl md:rounded-[2.5rem] border border-slate-100 p-6 md:p-8 space-y-6 md:space-y-8">
              <div className="flex flex-col gap-2 md:gap-3">
                <label className="text-[8px] md:text-[10px] font-black text-slate-400 uppercase tracking-widest">خوارزمية التحويل</label>
                <select 
                  value={selectedTransform}
                  onChange={(e) => setSelectedTransform(e.target.value as TransformationType)}
                  className="w-full bg-white border border-slate-200 rounded-xl p-3 md:p-4 text-xs font-black text-slate-800 outline-none focus:ring-4 focus:ring-amber-500/10 cursor-pointer transition-all appearance-none"
                >
                  <option value={TransformationType.AFFINE}>Affine (تحجيم وتدوير)</option>
                  <option value={TransformationType.HELMERT}>Helmert (تطابق)</option>
                  <option value={TransformationType.PROJECTIVE}>Projective (إسقاطي)</option>
                </select>
              </div>
              <div className="pt-4 md:pt-6 border-t border-slate-200/50 flex items-center justify-between">
                <div>
                  <p className="text-[10px] md:text-[11px] font-black text-slate-900">Merchich GCS</p>
                  <p className="text-[8px] md:text-[9px] font-bold text-slate-400 uppercase mt-1">المغرب - EPSG:6261</p>
                </div>
                <i className="fa-solid fa-earth-africa text-amber-600 text-lg md:text-xl"></i>
              </div>
            </div>
          </section>

          <div className="mt-auto space-y-4 md:space-y-5">
            <button 
              onClick={processGeoreferencing}
              disabled={!imgRef.current || status === AppStatus.PROCESSING}
              className={`w-full py-5 md:py-7 rounded-xl md:rounded-[2rem] font-black text-[10px] md:text-xs uppercase tracking-[0.2em] md:tracking-[0.3em] shadow-xl transition-all ${
                !imgRef.current 
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed' 
                  : 'bg-amber-600 text-white hover:bg-amber-700 hover:-translate-y-1 shadow-amber-600/20 active:translate-y-0'
              }`}
            >
              {status === AppStatus.PROCESSING ? (
                <><i className="fa-solid fa-spinner fa-spin mr-2 md:mr-3"></i> جاري التعرف...</>
              ) : (
                <><i className="fa-solid fa-wand-magic-sparkles mr-2 md:mr-3"></i> إسناد جغرافي آلي</>
              )}
            </button>

            {result && (
              <div className="flex flex-col gap-2 md:gap-3">
                <button 
                  onClick={downloadGisBundle}
                  className="w-full bg-slate-900 text-white py-3 md:py-4 rounded-xl md:rounded-2xl text-[9px] md:text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all flex items-center justify-center gap-2 md:gap-3 active:scale-95"
                >
                  <i className="fa-solid fa-file-zipper text-amber-500"></i>
                  تصدير حزمة GIS الكاملة
                </button>
                <div className="grid grid-cols-2 gap-2 md:gap-3">
                  <button 
                    onClick={downloadGCPFile}
                    className="bg-slate-100 text-slate-700 py-2 md:py-3 rounded-xl md:rounded-2xl text-[8px] md:text-[9px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
                  >
                    <i className="fa-solid fa-file-code"></i> GCP
                  </button>
                  <button 
                    onClick={() => {
                      if (result) {
                        const geojson = {
                          type: "FeatureCollection",
                          features: [{
                            type: "Feature",
                            properties: { name: "Boundary" },
                            geometry: { type: "Polygon", coordinates: [result.controlPoints.map(p => [p.lng, p.lat])] }
                          }]
                        };
                        const blob = new Blob([JSON.stringify(geojson)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); a.href = url; a.download = "boundary.geojson"; a.click();
                      }
                    }}
                    className="bg-slate-100 text-slate-700 py-2 md:py-3 rounded-xl md:rounded-2xl text-[8px] md:text-[9px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
                  >
                    <i className="fa-solid fa-vector-square"></i> GeoJSON
                  </button>
                </div>
              </div>
            )}
            
            <div className="flex justify-center gap-4 pt-4 border-t border-slate-100">
               <a href="https://github.com" target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-slate-900 transition-colors">
                 <i className="fa-brands fa-github text-xl"></i>
               </a>
               <a href="https://vercel.com" target="_blank" rel="noopener noreferrer" className="text-slate-300 hover:text-blue-500 transition-colors">
                 <i className="fa-solid fa-triangle-exclamation text-xl"></i>
               </a>
            </div>
          </div>
        </aside>

        {/* OVERLAY FOR MOBILE SIDEBAR */}
        {isSidebarOpen && (
          <div 
            onClick={() => setIsSidebarOpen(false)} 
            className="md:hidden fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-30"
          ></div>
        )}

        <section className="flex-1 relative overflow-hidden bg-slate-200 flex flex-col">
          <div className="flex-1 relative">
            <div className={`absolute inset-0 flex items-center justify-center p-4 md:p-16 transition-all duration-1000 ease-in-out ${viewMode === 'IMAGE' ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
               <div className="relative shadow-2xl rounded-2xl md:rounded-[3rem] overflow-hidden border-8 md:border-[16px] border-white bg-white max-h-full">
                 <canvas ref={canvasRef} className="max-w-full max-h-full block rounded-lg md:rounded-2xl" />
                 {!imgRef.current && (
                   <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/80 backdrop-blur-md p-6 md:p-16 text-center">
                     <div className="w-24 h-24 md:w-32 md:h-32 bg-white rounded-full shadow-2xl flex items-center justify-center mb-6 md:mb-10">
                        <i className="fa-solid fa-map-marked-alt text-4xl md:text-6xl text-slate-200"></i>
                     </div>
                     <h3 className="text-xl md:text-3xl font-black text-slate-900 mb-4 md:mb-6 tracking-tight uppercase italic">لا توجد خريطة</h3>
                     <p className="text-slate-400 text-[10px] md:text-base font-medium max-w-sm uppercase tracking-tighter">ارفع خريطة طبوغرافية للمغرب لتفعيل محرك الذكاء الاصطناعي.</p>
                   </div>
                 )}
               </div>
            </div>

            <div 
              ref={mapRef} 
              className={`absolute inset-0 transition-all duration-1000 ease-in-out ${viewMode === 'MAP' ? 'opacity-100 scale-100' : 'opacity-0 scale-110 pointer-events-none'}`}
            />

            {status === AppStatus.PROCESSING && (
              <div className="absolute inset-0 bg-white/90 backdrop-blur-3xl z-50 flex items-center justify-center p-8">
                <div className="flex flex-col items-center text-center max-w-sm">
                  <div className="relative w-24 h-24 md:w-40 md:h-40 mb-8 md:mb-14">
                     <div className="absolute inset-0 border-8 md:border-[12px] border-slate-100 rounded-full"></div>
                     <div className="absolute inset-0 border-8 md:border-[12px] border-amber-600 border-t-transparent rounded-full animate-spin"></div>
                     <div className="absolute inset-0 flex items-center justify-center">
                        <i className="fa-solid fa-microscope text-3xl md:text-5xl text-amber-600 animate-pulse"></i>
                     </div>
                  </div>
                  <h2 className="text-2xl md:text-4xl font-black mb-4 md:mb-6 tracking-tighter uppercase italic text-slate-900">معايرة الشبكة</h2>
                  <p className="text-slate-400 text-[10px] md:text-sm font-semibold mb-8 md:mb-14 uppercase tracking-[0.1em] md:tracking-[0.2em] italic leading-relaxed opacity-80">
                    جاري تحليل تقاطعات خطوط الطول والعرض ومطابقتها مع نظام Merchich...
                  </p>
                  <div className="w-full h-3 md:h-4 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                     <div className="h-full bg-amber-600 w-full animate-[progress_3s_infinite_linear]"></div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* GCP DATA TABLE PANEL - Responsive */}
          {result && tableState !== 'HIDDEN' && (
            <div className={`bg-white border-t border-slate-200 shadow-[0_-10px_40px_rgba(0,0,0,0.05)] transition-all duration-500 z-40 flex flex-col ${tableState === 'EXPANDED' ? 'h-[60vh] md:h-[400px]' : 'h-[60px]'}`}>
              <div className="px-4 md:px-6 h-[60px] flex items-center justify-between bg-slate-50/80 backdrop-blur shrink-0">
                <div className="flex items-center gap-2 md:gap-4 overflow-hidden">
                  <i className="fa-solid fa-table-list text-amber-600 shrink-0"></i>
                  <h3 className="text-[10px] md:text-xs font-black uppercase tracking-widest truncate">سجل نقاط التحكم (GCP)</h3>
                  <span className="hidden xs:inline-block text-[8px] md:text-[10px] font-bold bg-amber-100 text-amber-700 px-2 md:px-3 py-1 rounded-full whitespace-nowrap">{result.controlPoints.length} نقطة</span>
                </div>
                <div className="flex items-center gap-1 md:gap-2">
                  {tableState === 'MINIMIZED' ? (
                    <button onClick={() => setTableState('EXPANDED')} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-200 transition-colors">
                      <i className="fa-solid fa-chevron-up"></i>
                    </button>
                  ) : (
                    <button onClick={() => setTableState('MINIMIZED')} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-200 transition-colors">
                      <i className="fa-solid fa-chevron-down"></i>
                    </button>
                  )}
                  <button onClick={() => setTableState('HIDDEN')} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-100 text-red-500 transition-colors">
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-x-auto overflow-y-auto custom-scrollbar">
                <table className="w-full text-left text-[10px] md:text-xs min-w-[600px]">
                  <thead className="sticky top-0 bg-white z-10 shadow-sm">
                    <tr>
                      <th className="px-4 md:px-6 py-3 md:py-4 font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">ID</th>
                      <th className="px-4 md:px-6 py-3 md:py-4 font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Pixel Pos</th>
                      <th className="px-4 md:px-6 py-3 md:py-4 font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Longitude</th>
                      <th className="px-4 md:px-6 py-3 md:py-4 font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Latitude</th>
                      <th className="px-4 md:px-6 py-3 md:py-4 font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {result.controlPoints.map((cp) => (
                      <tr key={cp.id} className="hover:bg-amber-50/30 transition-colors group">
                        <td className="px-4 md:px-6 py-3 md:py-4 font-black text-slate-900">{cp.id}</td>
                        <td className="px-4 md:px-6 py-3 md:py-4 font-mono text-slate-500">{Math.round(cp.pixelX)},{Math.round(cp.pixelY)}</td>
                        <td className="px-4 md:px-6 py-3 md:py-4 font-mono font-bold text-slate-700">{cp.lng.toFixed(6)}°</td>
                        <td className="px-4 md:px-6 py-3 md:py-4 font-mono font-bold text-slate-700">{cp.lat.toFixed(6)}°</td>
                        <td className="px-4 md:px-6 py-3 md:py-4">
                          <span className="flex items-center gap-2 text-emerald-600 font-black text-[8px] md:text-[10px] uppercase">
                            <i className="fa-solid fa-check-double text-[6px] md:text-[8px]"></i> Calibrated
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="hidden md:flex bg-white border-t border-slate-200 px-10 py-3 justify-between items-center text-[8px] md:text-[10px] text-slate-400 font-black uppercase tracking-[0.4em] z-30 shrink-0">
        <div className="flex gap-12 items-center">
          <span className="flex items-center gap-3 text-amber-600"><i className="fa-solid fa-circle-check"></i> Merchich GCS EPSG:6261 Active</span>
          <span className="text-slate-300">© 2025 GEOSNAP AI - AUTOMATED GEOREFERENCING</span>
        </div>
        <div className="flex gap-4">
          <span className="text-slate-500 bg-slate-100 px-3 py-1 rounded-full">v2.5 Full Responsive</span>
        </div>
      </footer>
      
      <style>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @media (max-width: 400px) {
          .xs\\:inline { display: inline; }
          .xs\\:hidden { display: none; }
        }
      `}</style>
    </div>
  );
};

export default App;
