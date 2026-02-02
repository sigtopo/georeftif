
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
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(window.innerWidth >= 1024);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(true);
      }
    };
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
      if (window.innerWidth < 1024) setIsSidebarOpen(false);
    };
    img.onerror = () => {
      setError("فشل تحميل الصورة. قد يكون السبب سياسة CORS.");
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
        if (window.innerWidth < 1024) setIsSidebarOpen(false);
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
    map.getView().fit(extent3857, { padding: [100, 100, 100, 100], duration: 1500 });
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
      setTableState('MINIMIZED');
      
      setTimeout(() => updateMapPreview(finalResult), 200);
      if (window.innerWidth < 1024) setIsSidebarOpen(false);
    } catch (err: any) {
      setError("فشل تحليل الذكاء الاصطناعي. لم يتم التعرف على تقاطعات كافية.");
      setStatus(AppStatus.ERROR);
    }
  };

  const downloadGisBundle = async () => {
    if (!result?.transformation || !imgRef.current) return;
    setStatus(AppStatus.LOADING);
    
    try {
      const zip = new JSZip();
      const { A, B, C, D, E, F } = result.transformation;
      zip.file("raster.jgw", `${A}\n${D}\n${B}\n${E}\n${C}\n${F}`);
      zip.file("raster.prj", PRJ_DEFINITIONS['EPSG:6261']);
      
      const canvas = document.createElement('canvas');
      canvas.width = imgRef.current.width;
      canvas.height = imgRef.current.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(imgRef.current, 0, 0);
      const imageData = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
      zip.file("raster.jpg", imageData, { base64: true });
      
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GeoSnap_Output.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setStatus(AppStatus.SUCCESS);
    } catch (err) {
      setError("حدث خطأ أثناء التجميع.");
      setStatus(AppStatus.ERROR);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#f1f5f9] text-slate-700 overflow-hidden relative">
      {/* MOBILE COMPACT HEADER */}
      <header className="bg-white px-4 lg:px-10 py-3 lg:py-5 border-b border-slate-200 flex items-center justify-between z-30 shadow-sm shrink-0">
        <div className="flex items-center gap-3 lg:gap-5">
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="lg:hidden p-2 rounded-xl bg-slate-50 text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Toggle Sidebar"
          >
            <i className={`fa-solid ${isSidebarOpen ? 'fa-xmark' : 'fa-bars-staggered'} text-xl`}></i>
          </button>
          
          <div className="flex items-center gap-3">
            <div className="bg-amber-600 p-2 lg:p-2.5 rounded-xl shadow-lg shadow-amber-200/50 transform rotate-3">
              <i className="fa-solid fa-map-location-dot text-lg lg:text-2xl text-white"></i>
            </div>
            <div>
              <h1 className="text-base lg:text-2xl font-black tracking-tight text-slate-900 leading-none">GEOSNAP AI</h1>
              <p className="hidden xs:flex text-[8px] lg:text-[10px] uppercase font-black text-slate-400 tracking-[0.2em] mt-1 items-center gap-2">
                <span className="w-1.5 lg:w-2 h-1.5 lg:h-2 bg-emerald-500 rounded-full"></span>
                EPSG:6261 Morocco
              </p>
            </div>
          </div>
        </div>
        
        <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200 scale-90 lg:scale-100">
          <button 
            onClick={() => { setViewMode('IMAGE'); if (window.innerWidth < 1024) setIsSidebarOpen(false); }}
            className={`px-4 lg:px-7 py-1.5 lg:py-2.5 rounded-lg text-[10px] lg:text-xs font-black uppercase tracking-widest transition-all ${viewMode === 'IMAGE' ? 'bg-white shadow-sm text-amber-600' : 'text-slate-500'}`}
          >
            <i className="fa-solid fa-file-image lg:mr-2"></i> <span className="hidden sm:inline">صورة</span>
          </button>
          <button 
            onClick={() => {
              setViewMode('MAP');
              if (result) setTimeout(() => updateMapPreview(result), 50);
              if (window.innerWidth < 1024) setIsSidebarOpen(false);
            }}
            disabled={!result}
            className={`px-4 lg:px-7 py-1.5 lg:py-2.5 rounded-lg text-[10px] lg:text-xs font-black uppercase tracking-widest transition-all ${viewMode === 'MAP' ? 'bg-white shadow-sm text-amber-600' : 'text-slate-400 cursor-not-allowed'}`}
          >
            <i className="fa-solid fa-satellite lg:mr-2"></i> <span className="hidden sm:inline">خريطة</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden relative">
        {/* SIDEBAR - Responsive drawer on mobile */}
        <aside className={`
          ${isSidebarOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
          fixed lg:relative top-0 right-0 lg:right-auto
          w-[280px] sm:w-[320px] lg:w-[400px] 
          h-full lg:h-full
          bg-white border-l lg:border-l-0 lg:border-r border-slate-200 p-6 lg:p-10 
          flex flex-col gap-6 lg:gap-12 z-40 
          shadow-2xl lg:shadow-none 
          transition-transform duration-300 ease-in-out
          custom-scrollbar overflow-y-auto
        `}>
          <div className="lg:hidden flex justify-between items-center mb-4">
             <h2 className="text-sm font-black text-slate-900 uppercase tracking-widest">إعدادات المشروع</h2>
             <button onClick={() => setIsSidebarOpen(false)} className="text-slate-400"><i className="fa-solid fa-x"></i></button>
          </div>

          <section>
            <div className="flex items-center gap-4 mb-4 lg:mb-6">
              <div className="w-7 h-7 lg:w-8 lg:h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px] lg:text-xs font-black italic">01</div>
              <h2 className="text-[10px] lg:text-[11px] font-black text-slate-900 uppercase tracking-widest">استيراد الراستر</h2>
            </div>
            <div className="space-y-3">
              <form onSubmit={handleUrlSubmit} className="space-y-2">
                <input 
                  type="url" 
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="رابط الخريطة..."
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-semibold focus:border-amber-600 outline-none transition-all"
                />
                <button type="submit" className="w-full bg-slate-900 text-white py-3 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all">جلب الرابط</button>
              </form>
              <div className="relative">
                <input type="file" onChange={handleFileUpload} accept="image/*" id="file-up" className="hidden" />
                <label htmlFor="file-up" className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-2xl p-6 lg:p-10 cursor-pointer hover:border-amber-500 hover:bg-amber-50/20 transition-all text-center">
                  <i className="fa-solid fa-cloud-arrow-up text-2xl text-slate-300 mb-2"></i>
                  <span className="text-[9px] lg:text-[10px] font-black text-slate-400 uppercase tracking-widest">تحميل من الجهاز</span>
                </label>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-4 mb-4 lg:mb-6">
              <div className="w-7 h-7 lg:w-8 lg:h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px] lg:text-xs font-black italic">02</div>
              <h2 className="text-[10px] lg:text-[11px] font-black text-slate-900 uppercase tracking-widest">المحرك الجيوديسي</h2>
            </div>
            <div className="bg-slate-50 rounded-2xl p-5 lg:p-8 space-y-4">
              <div className="space-y-2">
                <label className="text-[9px] lg:text-[10px] font-black text-slate-400 uppercase tracking-widest">نوع التحويل</label>
                <select 
                  value={selectedTransform}
                  onChange={(e) => setSelectedTransform(e.target.value as TransformationType)}
                  className="w-full bg-white border border-slate-200 rounded-xl p-3 text-xs font-black text-slate-800 outline-none"
                >
                  <option value={TransformationType.AFFINE}>Affine (6-Param)</option>
                  <option value={TransformationType.HELMERT}>Helmert (Conformal)</option>
                </select>
              </div>
              <div className="pt-4 border-t border-slate-200/50 flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-black text-slate-900 leading-none">Merchich GCS</p>
                  <p className="text-[8px] font-bold text-slate-400 uppercase mt-1">EPSG:6261 Morocco</p>
                </div>
                <i className="fa-solid fa-earth-africa text-amber-600"></i>
              </div>
            </div>
          </section>

          <div className="mt-auto space-y-4">
            <button 
              onClick={processGeoreferencing}
              disabled={!imgRef.current || status === AppStatus.PROCESSING}
              className={`w-full py-5 lg:py-7 rounded-2xl font-black text-[10px] lg:text-xs uppercase tracking-[0.2em] shadow-xl transition-all ${
                !imgRef.current ? 'bg-slate-100 text-slate-300' : 'bg-amber-600 text-white hover:bg-amber-700 shadow-amber-600/20'
              }`}
            >
              {status === AppStatus.PROCESSING ? 'جاري التحليل...' : 'إسناد آلي بالذكاء الاصطناعي'}
            </button>

            {result && (
              <button 
                onClick={downloadGisBundle}
                className="w-full bg-slate-900 text-white py-4 lg:py-5 rounded-2xl text-[9px] lg:text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-3"
              >
                <i className="fa-solid fa-download"></i> تصدير حزمة GIS
              </button>
            )}

            <div className="flex justify-center items-center gap-6 pt-6 border-t border-slate-100">
               <a href="https://github.com" target="_blank" className="text-slate-300 hover:text-slate-900 transition-colors"><i className="fa-brands fa-github text-xl"></i></a>
               <a href="https://vercel.com" target="_blank" className="text-slate-300 hover:text-blue-500 transition-colors"><i className="fa-solid fa-triangle-exclamation text-xl"></i></a>
            </div>
          </div>
        </aside>

        {/* OVERLAY FOR MOBILE SIDEBAR */}
        {isSidebarOpen && (
          <div onClick={() => setIsSidebarOpen(false)} className="lg:hidden fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-30"></div>
        )}

        <section className="flex-1 relative overflow-hidden bg-slate-200 flex flex-col">
          <div className="flex-1 relative">
            <div className={`absolute inset-0 flex items-center justify-center p-4 lg:p-16 transition-all duration-1000 ${viewMode === 'IMAGE' ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
               <div className="relative shadow-2xl rounded-2xl lg:rounded-[3rem] overflow-hidden border-4 lg:border-[16px] border-white bg-white max-h-full">
                 <canvas ref={canvasRef} className="max-w-full max-h-full block" />
                 {!imgRef.current && (
                   <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/80 backdrop-blur-md p-6 lg:p-16 text-center">
                     <i className="fa-solid fa-map-marked-alt text-4xl lg:text-6xl text-slate-200 mb-6"></i>
                     <h3 className="text-lg lg:text-3xl font-black text-slate-900 mb-4 tracking-tight uppercase">بانتظار الخريطة</h3>
                     <p className="text-slate-400 text-[10px] lg:text-base font-medium max-w-sm uppercase">ارفع خريطة طبوغرافية للمغرب لتفعيل محرك الذكاء الاصطناعي.</p>
                   </div>
                 )}
               </div>
            </div>

            <div ref={mapRef} className={`absolute inset-0 transition-all duration-1000 ${viewMode === 'MAP' ? 'opacity-100 scale-100' : 'opacity-0 scale-110 pointer-events-none'}`} />

            {status === AppStatus.PROCESSING && (
              <div className="absolute inset-0 bg-white/95 backdrop-blur-3xl z-50 flex items-center justify-center p-8">
                <div className="flex flex-col items-center text-center max-w-xs">
                  <div className="relative w-24 lg:w-40 h-24 lg:h-40 mb-10">
                     <div className="absolute inset-0 border-8 lg:border-[12px] border-slate-100 rounded-full"></div>
                     <div className="absolute inset-0 border-8 lg:border-[12px] border-amber-600 border-t-transparent rounded-full animate-spin"></div>
                     <div className="absolute inset-0 flex items-center justify-center">
                        <i className="fa-solid fa-microscope text-3xl lg:text-5xl text-amber-600 animate-pulse"></i>
                     </div>
                  </div>
                  <h2 className="text-2xl lg:text-4xl font-black mb-4 tracking-tighter uppercase italic text-slate-900">معايرة ذكية</h2>
                  <p className="text-slate-400 text-[10px] lg:text-sm font-semibold mb-10 uppercase tracking-[0.1em] leading-relaxed">
                    جاري مطابقة تقاطعات الشبكة مع الإحداثيات الجغرافية...
                  </p>
                  <div className="w-full h-3 lg:h-4 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                     <div className="h-full bg-amber-600 w-full animate-[progress_3s_infinite_linear]"></div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* DATA PANEL */}
          {result && tableState !== 'HIDDEN' && (
            <div className={`bg-white border-t border-slate-200 shadow-2xl transition-all duration-500 z-40 flex flex-col ${tableState === 'EXPANDED' ? 'h-[60vh] lg:h-[400px]' : 'h-[60px]'}`}>
              <div className="px-4 lg:px-6 h-[60px] flex items-center justify-between bg-slate-50/80 backdrop-blur shrink-0">
                <div className="flex items-center gap-4 overflow-hidden">
                  <i className="fa-solid fa-table-list text-amber-600"></i>
                  <h3 className="text-[10px] lg:text-xs font-black uppercase tracking-widest truncate">نقاط التحكم (GCP)</h3>
                  <span className="hidden xs:inline-block text-[8px] lg:text-[10px] font-bold bg-amber-100 text-amber-700 px-3 py-1 rounded-full">{result.controlPoints.length} نقطة</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => setTableState(tableState === 'EXPANDED' ? 'MINIMIZED' : 'EXPANDED')} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-200 transition-colors">
                    <i className={`fa-solid ${tableState === 'EXPANDED' ? 'fa-chevron-down' : 'fa-chevron-up'}`}></i>
                  </button>
                  <button onClick={() => setTableState('HIDDEN')} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-red-500 transition-colors">
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
              </div>
              
              <div className="flex-1 overflow-auto custom-scrollbar">
                <table className="w-full text-right text-[10px] lg:text-xs min-w-[500px]">
                  <thead className="sticky top-0 bg-white z-10 shadow-sm">
                    <tr>
                      <th className="px-6 py-4 font-black text-slate-400 uppercase border-b border-slate-100">ID</th>
                      <th className="px-6 py-4 font-black text-slate-400 uppercase border-b border-slate-100">بكسل</th>
                      <th className="px-6 py-4 font-black text-slate-400 uppercase border-b border-slate-100">خط الطول</th>
                      <th className="px-6 py-4 font-black text-slate-400 uppercase border-b border-slate-100">خط العرض</th>
                      <th className="px-6 py-4 font-black text-slate-400 uppercase border-b border-slate-100">الحالة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {result.controlPoints.map((cp) => (
                      <tr key={cp.id} className="hover:bg-amber-50/30 transition-colors">
                        <td className="px-6 py-4 font-black text-slate-900">{cp.id}</td>
                        <td className="px-6 py-4 font-mono text-slate-500">{Math.round(cp.pixelX)},{Math.round(cp.pixelY)}</td>
                        <td className="px-6 py-4 font-mono font-bold text-slate-700">{cp.lng.toFixed(6)}°</td>
                        <td className="px-6 py-4 font-mono font-bold text-slate-700">{cp.lat.toFixed(6)}°</td>
                        <td className="px-6 py-4 text-emerald-600 font-black text-[9px]">CALIBRATED</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* FOOTER - Hidden on mobile */}
      <footer className="hidden lg:flex bg-white border-t border-slate-200 px-10 py-3 justify-between items-center text-[10px] text-slate-400 font-black uppercase tracking-[0.4em] z-30 shrink-0">
        <div className="flex gap-12 items-center">
          <span className="flex items-center gap-3 text-amber-600"><i className="fa-solid fa-circle-check"></i> Merchich GCS EPSG:6261 Active</span>
          <span className="text-slate-300">© 2025 GEOSNAP AI - MOROCCO ENGINE</span>
        </div>
        <div className="flex gap-4">
          <span className="text-slate-500 bg-slate-100 px-3 py-1 rounded-full">Deployment Status: Live</span>
        </div>
      </footer>
      
      <style>{`
        @keyframes progress { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @media (max-width: 640px) { .xs\\:flex { display: flex; } .xs\\:hidden { display: none; } }
      `}</style>
    </div>
  );
};

export default App;
