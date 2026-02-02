
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
import { Style, Icon, Text, Fill, Stroke, RegularShape } from 'ol/style';
import { fromLonLat, transformExtent } from 'ol/proj';
import { register } from 'ol/proj/proj4';

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
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<Map | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

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
    for (let i = layers.length - 1; i >= 1; i--) {
      map.removeLayer(layers[i]);
    }

    const { A, B, C, D, E, F } = res.transformation;
    const w = imgRef.current.width;
    const h = imgRef.current.height;

    // حساب إحداثيات الأركان الأربعة بناءً على مصفوفة التحويل (Affine Matrix)
    // X = Ax + By + C
    // Y = Dx + Ey + F
    const c1 = [C, F]; // Top-Left (0,0)
    const c2 = [A * w + C, D * w + F]; // Top-Right (w,0)
    const c3 = [A * w + B * h + C, D * w + E * h + F]; // Bottom-Right (w,h)
    const c4 = [B * h + C, E * h + F]; // Bottom-Left (0,h)

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
    res.controlPoints.forEach(cp => {
      const feature = new Feature({
        geometry: new Point(fromLonLat([cp.lng, cp.lat]))
      });

      // تصميم نقطة GCP لتكون دقيقة ومغطية للمكان
      feature.setStyle(new Style({
        image: new RegularShape({
          fill: new Fill({ color: 'rgba(234, 88, 12, 0.4)' }),
          stroke: new Stroke({ color: '#ea580c', width: 2 }),
          points: 4,
          radius: 12,
          angle: Math.PI / 4,
        }),
        text: new Text({
          text: cp.id,
          offsetY: -20,
          font: '900 12px Inter',
          fill: new Fill({ color: '#ffffff' }),
          stroke: new Stroke({ color: '#ea580c', width: 3 }),
          backgroundFill: new Fill({ color: 'rgba(15, 23, 42, 0.8)' }),
          padding: [4, 8, 4, 8]
        })
      }));
      
      // طبقة ثانية للكروس هير (Crosshair) للدقة
      const crossStyle = new Style({
        image: new RegularShape({
          stroke: new Stroke({ color: '#ffffff', width: 1 }),
          points: 4,
          radius: 18,
          radius2: 0,
          angle: 0
        })
      });
      
      const featureCross = new Feature({
        geometry: new Point(fromLonLat([cp.lng, cp.lat]))
      });
      featureCross.setStyle(crossStyle);

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
      
      setTimeout(() => updateMapPreview(finalResult), 100);
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
    <div className="flex flex-col h-screen bg-[#f1f5f9] text-slate-700 overflow-hidden font-['Inter']">
      <header className="bg-white px-10 py-5 border-b border-slate-200 flex items-center justify-between z-30 shadow-sm">
        <div className="flex items-center gap-5">
          <div className="bg-amber-600 p-2.5 rounded-2xl shadow-lg shadow-amber-200/50 transform rotate-3">
            <i className="fa-solid fa-map-location-dot text-2xl text-white"></i>
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-900 leading-none">GEOSNAP <span className="text-amber-600 italic">MOROCCO</span></h1>
            <p className="text-[10px] uppercase font-black text-slate-400 tracking-[0.2em] mt-1.5 flex items-center gap-2">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
              نظام الإسناد الآلي EPSG:6261
            </p>
          </div>
        </div>
        
        <div className="flex bg-slate-100 p-1.5 rounded-2xl border border-slate-200">
          <button 
            onClick={() => setViewMode('IMAGE')}
            className={`px-7 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'IMAGE' ? 'bg-white shadow-md text-amber-600' : 'text-slate-500 hover:text-slate-800'}`}
          >
            <i className="fa-solid fa-file-image"></i> المعاينة الأصلية
          </button>
          <button 
            onClick={() => {
              setViewMode('MAP');
              if (result) setTimeout(() => updateMapPreview(result), 50);
            }}
            disabled={!result}
            className={`px-7 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${viewMode === 'MAP' ? 'bg-white shadow-md text-amber-600' : 'text-slate-400 cursor-not-allowed'} ${result ? 'hover:text-slate-800' : ''}`}
          >
            <i className="fa-solid fa-satellite"></i> المعاينة الجغرافية
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        <aside className="w-[400px] bg-white border-r border-slate-200 p-10 flex flex-col gap-12 z-20 shadow-xl custom-scrollbar overflow-y-auto">
          <section>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-black italic">01</div>
              <h2 className="text-[11px] font-black text-slate-900 uppercase tracking-widest">تحميل الخريطة</h2>
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
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 py-4 text-xs font-semibold focus:ring-4 focus:ring-amber-500/10 focus:border-amber-600 outline-none transition-all"
                  />
                </div>
                <button type="submit" className="w-full mt-3 bg-slate-900 text-white py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all active:scale-95">
                  جلب من الرابط
                </button>
              </form>
              <div className="relative group">
                <input type="file" onChange={handleFileUpload} accept="image/*" id="file-upload" className="hidden" />
                <label htmlFor="file-upload" className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-[2.5rem] p-10 cursor-pointer hover:border-amber-500 hover:bg-amber-50/20 transition-all">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4 group-hover:bg-amber-100 transition-colors">
                    <i className="fa-solid fa-upload text-2xl text-slate-300 group-hover:text-amber-600"></i>
                  </div>
                  <span className="text-[10px] font-black text-slate-400 group-hover:text-amber-700 uppercase tracking-widest">رفع ملف محلي</span>
                </label>
              </div>
            </div>
          </section>

          <section>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-8 h-8 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-black italic">02</div>
              <h2 className="text-[11px] font-black text-slate-900 uppercase tracking-widest">إعدادات المعالجة</h2>
            </div>
            <div className="bg-slate-50 rounded-[2.5rem] border border-slate-100 p-8 space-y-8">
              <div className="flex flex-col gap-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">خوارزمية التحويل</label>
                <select 
                  value={selectedTransform}
                  onChange={(e) => setSelectedTransform(e.target.value as TransformationType)}
                  className="w-full bg-white border border-slate-200 rounded-2xl p-4 text-xs font-black text-slate-800 outline-none focus:ring-4 focus:ring-amber-500/10 cursor-pointer transition-all appearance-none"
                >
                  <option value={TransformationType.AFFINE}>Affine (تحجيم وتدوير)</option>
                  <option value={TransformationType.HELMERT}>Helmert (تطابق)</option>
                  <option value={TransformationType.PROJECTIVE}>Projective (إسقاطي)</option>
                </select>
              </div>
              <div className="pt-6 border-t border-slate-200/50 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-black text-slate-900">Merchich GCS</p>
                  <p className="text-[9px] font-bold text-slate-400 uppercase mt-1">المغرب - EPSG:6261</p>
                </div>
                <i className="fa-solid fa-earth-africa text-amber-600 text-xl"></i>
              </div>
            </div>
          </section>

          <div className="mt-auto space-y-5">
            <button 
              onClick={processGeoreferencing}
              disabled={!imgRef.current || status === AppStatus.PROCESSING}
              className={`w-full py-7 rounded-[2rem] font-black text-xs uppercase tracking-[0.3em] shadow-xl transition-all ${
                !imgRef.current 
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed' 
                  : 'bg-amber-600 text-white hover:bg-amber-700 hover:-translate-y-1 shadow-amber-600/20 active:translate-y-0'
              }`}
            >
              {status === AppStatus.PROCESSING ? (
                <><i className="fa-solid fa-spinner fa-spin mr-3"></i> جاري التعرف...</>
              ) : (
                <><i className="fa-solid fa-wand-magic-sparkles mr-3"></i> إسناد جغرافي آلي</>
              )}
            </button>

            {result && (
              <button 
                onClick={downloadGisBundle}
                className="w-full bg-slate-900 text-white py-7 rounded-[2rem] text-xs font-black uppercase tracking-widest hover:bg-slate-800 transition-all flex items-center justify-center gap-4 active:scale-95"
              >
                <i className="fa-solid fa-file-zipper text-amber-500"></i>
                تصدير حزمة GIS
              </button>
            )}
          </div>
        </aside>

        <section className="flex-1 relative overflow-hidden bg-slate-200">
          <div className={`absolute inset-0 flex items-center justify-center p-16 transition-all duration-1000 ease-in-out ${viewMode === 'IMAGE' ? 'opacity-100 scale-100' : 'opacity-0 scale-95 pointer-events-none'}`}>
             <div className="relative shadow-2xl rounded-[3rem] overflow-hidden border-[16px] border-white bg-white max-h-full">
               <canvas ref={canvasRef} className="max-w-full max-h-full block rounded-2xl" />
               {!imgRef.current && (
                 <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-50/80 backdrop-blur-md p-16 text-center">
                   <div className="w-32 h-32 bg-white rounded-full shadow-2xl flex items-center justify-center mb-10">
                      <i className="fa-solid fa-map-marked-alt text-6xl text-slate-200"></i>
                   </div>
                   <h3 className="text-3xl font-black text-slate-900 mb-6 tracking-tight uppercase italic">لا توجد خريطة</h3>
                   <p className="text-slate-400 text-base font-medium max-w-sm uppercase tracking-tighter">ارفع خريطة طبوغرافية للمغرب لتفعيل محرك الذكاء الاصطناعي.</p>
                 </div>
               )}
             </div>
          </div>

          <div 
            ref={mapRef} 
            className={`absolute inset-0 transition-all duration-1000 ease-in-out ${viewMode === 'MAP' ? 'opacity-100 scale-100' : 'opacity-0 scale-110 pointer-events-none'}`}
          />

          {status === AppStatus.PROCESSING && (
            <div className="absolute inset-0 bg-white/90 backdrop-blur-3xl z-50 flex items-center justify-center">
              <div className="flex flex-col items-center text-center max-w-sm">
                <div className="relative w-40 h-40 mb-14">
                   <div className="absolute inset-0 border-[12px] border-slate-100 rounded-full"></div>
                   <div className="absolute inset-0 border-[12px] border-amber-600 border-t-transparent rounded-full animate-spin"></div>
                   <div className="absolute inset-0 flex items-center justify-center">
                      <i className="fa-solid fa-microscope text-5xl text-amber-600 animate-pulse"></i>
                   </div>
                </div>
                <h2 className="text-4xl font-black mb-6 tracking-tighter uppercase italic text-slate-900">معايرة الشبكة</h2>
                <p className="text-slate-400 text-sm font-semibold mb-14 uppercase tracking-[0.2em] italic leading-relaxed opacity-80">
                  جاري تحليل تقاطعات خطوط الطول والعرض ومطابقتها مع نظام Merchich...
                </p>
                <div className="w-full h-4 bg-slate-100 rounded-full overflow-hidden border border-slate-200">
                   <div className="h-full bg-amber-600 w-full animate-[progress_3s_infinite_linear]"></div>
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="bg-white border-t border-slate-200 px-10 py-4 flex justify-between items-center text-[10px] text-slate-400 font-black uppercase tracking-[0.4em] z-30">
        <div className="flex gap-12 items-center">
          <span className="flex items-center gap-3 text-amber-600"><i className="fa-solid fa-circle-check"></i> Merchich GCS EPSG:6261 Active</span>
          <span className="text-slate-300">© 2025 GEOSNAP AI - AUTOMATED GEOREFERENCING</span>
        </div>
      </footer>
      
      <style>{`
        @keyframes progress {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
};

export default App;
