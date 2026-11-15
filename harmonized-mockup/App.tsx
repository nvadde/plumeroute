import React, { useMemo, useState } from "react";
import {
  Flame, Search, Mic, ChevronDown, Check, CalendarDays, TrendingUp,
  Activity, Zap, Eye, ArrowUpRight, ArrowDownRight, MapPin, X, Layers,
} from "lucide-react";

const YEARS = [2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026];
const BASE_YEARLY: Record<number, number> = {2012:410000,2013:385000,2014:450000,2015:520000,2016:480000,2017:518000,2018:613075,2019:580000,2020:490000,2021:430000,2022:395000,2023:410000,2024:445000,2025:470000,2026:390000};
const COUNTRIES = [
  { name: "Brazil", factor: 1, code: "BR" },
  { name: "USA", factor: 0.399, code: "US" },
  { name: "Indonesia", factor: 0.294, code: "ID" },
  { name: "Australia", factor: 0.268, code: "AU" },
  { name: "DRC", factor: 0.235, code: "CD" },
  { name: "Bolivia", factor: 0.178, code: "BO" },
  { name: "Peru", factor: 0.152, code: "PE" },
  { name: "Colombia", factor: 0.121, code: "CO" },
  { name: "Mexico", factor: 0.108, code: "MX" },
  { name: "India", factor: 0.089, code: "IN" },
];
const METRICS = ["Active Fire Cells", "Total FRP", "Max FRP", "VIIRS-only Cells"] as const;
type Metric = typeof METRICS[number];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHLY_BASE = [1200,900,1800,4200,8500,14500,28500,85000,165000,98000,42000,8500];
const MONTHLY_2017 = [980,760,1500,3600,7200,12100,23800,71200,138000,82100,35100,7100];
const PEAK_BASE = [
  { date: "2018-09-12", cells: 9896, frp: 447180, max: 7303 },
  { date: "2018-09-10", cells: 9620, frp: 412000, max: 6800 },
  { date: "2018-09-15", cells: 9100, frp: 398000, max: 6500 },
  { date: "2018-08-28", cells: 8750, frp: 365000, max: 6200 },
  { date: "2018-09-08", cells: 8400, frp: 340000, max: 5900 },
  { date: "2018-10-02", cells: 8100, frp: 320000, max: 5600 },
  { date: "2018-09-20", cells: 7800, frp: 305000, max: 5400 },
  { date: "2018-08-30", cells: 7600, frp: 295000, max: 5200 },
  { date: "2018-09-05", cells: 7400, frp: 285000, max: 5100 },
  { date: "2018-10-10", cells: 7200, frp: 270000, max: 4950 },
];

function fmt(n: number) { return Math.round(n).toLocaleString("en-US"); }
function compact(n: number) {
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n/1000).toFixed(0)}k`;
  return `${Math.round(n)}`;
}
function metricValue(cells: number, metric: Metric) {
  if (metric === "Total FRP") return cells * 28.9;
  if (metric === "Max FRP") return 4200 + (cells - 385000) / 228000 * 3100;
  if (metric === "VIIRS-only Cells") return cells * 0.678;
  return cells;
}
function metricLabel(v: number, metric: Metric) {
  if (metric === "Total FRP") return `${(v/1000000).toFixed(1)}M MW`;
  if (metric === "Max FRP") return `${Math.round(v).toLocaleString()} MW`;
  return `${compact(v)} cells`;
}

const shellStyle = { boxSizing: "border-box" as const, paddingTop: "var(--safe-area-inset-top)" };

export default function App() {
  const [activeTab, setActiveTab] = useState<"Trend"|"Live"|"Harmonized">("Harmonized");
  const [countryName, setCountryName] = useState("Brazil");
  const [selectedYear, setSelectedYear] = useState(2018);
  const [yearFilter, setYearFilter] = useState<number[]>([2018]);
  const [yearOpen, setYearOpen] = useState(false);
  const [metric, setMetric] = useState<Metric>("Active Fire Cells");
  const [compare, setCompare] = useState<"Off"|"Avg">("Off");
  const [search, setSearch] = useState("");
  const [listening, setListening] = useState(false);
  const [sortKey, setSortKey] = useState<"cells"|"frp"|"max"|"date">("cells");
  const [sortDir, setSortDir] = useState<1|-1>(-1);
  const [selectedDay, setSelectedDay] = useState(0);

  const country = COUNTRIES.find(c=>c.name===countryName) || COUNTRIES[0];
  const yearly = useMemo(()=> YEARS.map(y=>({ year: y, cells: Math.round(BASE_YEARLY[y]*country.factor) })), [country.factor]);
  const selectedCells = Math.round((BASE_YEARLY[selectedYear]||613075)*country.factor);
  const avgCells = Math.round(465000*country.factor);
  const diffPct = ((selectedCells - avgCells)/avgCells*100);
  const totalFRP = selectedCells*28.9;
  const peakCells = Math.round(selectedCells*0.01614);
  const peakDayNum = selectedYear===2018 ? 12 : 6 + (selectedYear % 7);
  const viirsPct = Math.min(71, Math.max(62, 67.8 + (selectedYear-2018)*0.35 + (country.factor-1)*2));
  const yoy = selectedYear>2012 ? ((selectedCells - Math.round(BASE_YEARLY[selectedYear-1]*country.factor))/Math.round(BASE_YEARLY[selectedYear-1]*country.factor)*100) : 18.2;

  const visibleYears = yearFilter.length===0 ? yearly : yearly.filter(d=>yearFilter.includes(d.year));
  const maxMetric = Math.max(...yearly.map(d=>metricValue(d.cells, metric))) * 1.12;
  const avgMetric = metricValue(avgCells, metric);

  const monthly = MONTHLY_BASE.map((v,i)=> Math.round(v * (selectedCells/613075)));
  const monthly2017 = MONTHLY_2017.map((v,i)=> Math.round(v * (selectedCells/613075)));
  const maxMonthly = Math.max(...monthly);

  const peakDays = useMemo(()=>{
    const scale = selectedCells/613075;
    const rows = PEAK_BASE.map((r,idx)=>{
      const day = r.date.slice(5);
      const yearPart = `${selectedYear}-${day}`;
      return { ...r, date: yearPart, cells: Math.round(r.cells*scale), frp: Math.round(r.frp*scale), max: Math.round(r.max*(0.82+scale*0.18)), rank: idx+1 };
    });
    const sorted = [...rows].sort((a,b)=>{
      const av = sortKey==="date"? a.date : a[sortKey]; const bv = sortKey==="date"? b.date : b[sortKey];
      if (typeof av==="string") return sortDir * av.localeCompare(bv as string);
      return sortDir * ((av as number)-(bv as number));
    });
    return sorted;
  }, [selectedCells, selectedYear, sortKey, sortDir]);

  const toggleYear = (y:number)=>{
    setYearFilter(prev=> prev.includes(y) ? prev.filter(v=>v!==y) : [...prev, y]);
  };
  const yearButtonLabel = yearFilter.length===0 ? "All Years" : yearFilter.length===1 ? `${yearFilter[0]}` : yearFilter.length===YEARS.length ? "All Years" : `${yearFilter.length} years`;
  const bothPct = Math.max(7, 9.9 - (selectedYear-2018)*0.12);
  const modisPct = Math.max(18, 100 - viirsPct - bothPct);

  const calendarColors = ["#FFFBF5","#FEF3C7","#FDE68A","#FDBA74","#FB923C","#EA580C","#9A3412"];
  const calendar = MONTHS.map((m,mi)=>{
    const norm = monthly[mi]/maxMonthly;
    return Array.from({length:5},(_,wi)=>{
      const seed = ((mi*7 + wi*13) % 10)/10;
      const intensity = Math.min(1, norm*(0.55+seed*0.75));
      const idx = intensity<=0.02?0: intensity<0.12?1: intensity<0.28?2: intensity<0.48?3: intensity<0.72?4: intensity<0.92?5:6;
      return calendarColors[idx];
    });
  });

  const sortHeader = (label:string, key:typeof sortKey)=>{
    const active = sortKey===key;
    return <button onClick={()=>{ if(active) setSortDir(d=> d===1?-1:1); else {setSortKey(key); setSortDir(-1);} }} className="flex items-center gap-1 font-semibold text-slate-900 hover:text-orange-700">{label}<span className="text-[10px] text-slate-400">{active ? (sortDir===-1?"▼":"▲") : "↕"}</span></button>;
  };

  return (
    <div data-safe-area-inset-root style={shellStyle} className="min-h-screen bg-[#FFFBF5] text-slate-900 overflow-x-clip">
      {/* HEADER */}
      <header data-safe-area-sticky-top style={{top:"var(--safe-area-inset-top)"}} className="sticky z-30 bg-[#0A0A0A] text-white shadow-md">
        <div className="mx-auto max-w-[1280px] px-3 sm:px-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <div className="flex items-center gap-2 shrink-0">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-orange-600"><Flame className="h-5 w-5 text-white" fill="currentColor" /></span>
              <span className="text-[19px] font-extrabold tracking-tight">PlumeRoute</span>
            </div>
            <nav className="flex items-center gap-1 rounded-full bg-[#1C1C1C] p-1">
              {(["Trend","Live","Harmonized"] as const).map(t=>(
                <button key={t} onClick={()=>setActiveTab(t)} className={`rounded-full px-3 sm:px-4 py-1.5 text-[13px] font-semibold transition ${activeTab===t?"bg-white text-black shadow":"text-zinc-300 hover:text-white"}`}>{t}</button>
              ))}
            </nav>
            <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-[430px] relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search a place — try 'prainha'" className="w-full rounded-full bg-[#222222] border border-[#333] py-2 pl-9 pr-8 text-[13px] text-white placeholder:text-zinc-500 outline-none focus:border-orange-500" />
              {search && <button aria-label="Clear search" onClick={()=>setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white"><X className="h-4 w-4"/></button>}
            </div>
            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <button onClick={()=>setListening(v=>!v)} className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-[12px] sm:text-[13px] font-bold whitespace-nowrap transition ${listening?"bg-amber-300 text-black":"bg-orange-600 text-white hover:bg-orange-500"}`}><Mic className="h-4 w-4"/>{listening?"Listening…":"Ask by voice"}</button>
              <span className="hidden lg:block text-[11px] font-bold tracking-widest text-zinc-300">FIRMS <span className="text-orange-400">•</span> <span className="font-medium tracking-normal text-zinc-400">no detections in view</span></span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-3 sm:px-5 pb-10 pt-4 sm:pt-5">
        {search && <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[13px]"><span>Search: <b>“{search}”</b> — no matching place in this Harmonized mockup. Try a country below.</span><button onClick={()=>setSearch("")} className="font-bold text-orange-700">Clear</button></div>}
        {listening && <div className="mb-3 rounded-xl bg-orange-50 border border-orange-200 px-3 py-2 text-[13px] text-orange-900">Voice is a mockup control — say a country name, then pick it in the Country control below.</div>}

        {activeTab!=="Harmonized" ? (
          <section className="rounded-2xl border border-[#E7E5E4] bg-white p-6 sm:p-10 text-center shadow-sm">
            <div className="mx-auto max-w-[520px]"><span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1 text-[11px] font-bold tracking-widest text-orange-700 uppercase"><Layers className="h-3.5 w-3.5"/> {activeTab} preview</span><h1 className="mt-4 text-2xl font-extrabold">This mockup focuses on Harmonized.</h1><p className="mt-2 text-sm leading-6 text-slate-500">The {activeTab} view is not included in this tab mockup. Return to Harmonized to explore the harmonized history, sensor split, and peak days.</p><button onClick={()=>setActiveTab("Harmonized")} className="mt-5 rounded-full bg-[#0A0A0A] px-5 py-2.5 text-sm font-bold text-white">Back to Harmonized</button></div>
          </section>
        ) : (<>
        {/* CONTROL BAR */}
        <section className="rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-5 shadow-[0_2px_14px_rgba(0,0,0,0.04)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[11px] font-extrabold tracking-[0.16em] text-slate-500">1 • COUNTRY &amp; YEAR — PICK A COUNTRY</p><h1 className="mt-1 text-[20px] sm:text-[24px] leading-tight font-extrabold tracking-tight">Harmonized fire history <span className="text-orange-600">for {countryName}</span></h1></div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FFFBF5] border border-[#E7E5E4] px-3 py-1.5 text-[12px] font-semibold text-slate-600"><MapPin className="h-3.5 w-3.5 text-orange-600"/>{country.code} • 1 km grid • {selectedYear}</span>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1.25fr_1.6fr_1fr]">
            <label className="block"><span className="mb-1.5 block text-[11px] font-bold tracking-wider text-slate-500">COUNTRY</span>
              <div className="relative"><select value={countryName} onChange={e=>setCountryName(e.target.value)} className="w-full appearance-none rounded-xl border border-[#E7E5E4] bg-white px-3 py-2.5 pr-9 text-[14px] font-semibold outline-none focus:border-orange-500">{COUNTRIES.map(c=><option key={c.name} value={c.name}>{c.name}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400"/></div>
            </label>

            <div className="relative"><span className="mb-1.5 block text-[11px] font-bold tracking-wider text-slate-500">YEAR — MULTI-SELECT</span>
              <button onClick={()=>setYearOpen(v=>!v)} className="flex w-full items-center justify-between rounded-xl border border-[#E7E5E4] bg-white px-3 py-2.5 text-[14px] font-semibold"><span>{yearButtonLabel} <span className="font-normal text-slate-400">• chart filter</span></span><ChevronDown className={`h-4 w-4 text-slate-400 transition ${yearOpen?"rotate-180":""}`}/></button>
              {yearOpen && <div className="absolute z-20 mt-2 w-full rounded-xl border border-[#E7E5E4] bg-white p-2 shadow-xl max-h-[240px] overflow-y-auto">
                <button onClick={()=>setYearFilter([])} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[13px] font-semibold hover:bg-orange-50"><span>All Years</span><span className={`grid h-4 w-4 place-items-center rounded border ${yearFilter.length===0?"bg-orange-600 border-orange-600 text-white":"border-slate-300"}`}>{yearFilter.length===0 && <Check className="h-3 w-3"/>}</span></button>
                {YEARS.map(y=><button key={y} onClick={()=>toggleYear(y)} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[13px] hover:bg-orange-50"><span>{y} {y===selectedYear && <span className="ml-1 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-bold text-orange-700">SELECTED</span>}</span><span className={`grid h-4 w-4 place-items-center rounded border ${yearFilter.includes(y)?"bg-orange-600 border-orange-600 text-white":"border-slate-300"}`}>{yearFilter.includes(y) && <Check className="h-3 w-3"/>}</span></button>)}
                <button onClick={()=>setYearOpen(false)} className="mt-1 w-full rounded-lg bg-[#0A0A0A] py-2 text-[12px] font-bold text-white">Done</button>
              </div>}
            </div>

            <div><span className="mb-1.5 block text-[11px] font-bold tracking-wider text-slate-500">METRIC</span>
              <div className="flex flex-wrap gap-1.5">{METRICS.map(m=><button key={m} onClick={()=>setMetric(m)} className={`rounded-full px-2.5 py-2 text-[12px] font-semibold border transition ${metric===m?"bg-[#0A0A0A] text-white border-black":"bg-white text-slate-600 border-[#E7E5E4] hover:border-orange-300"}`}>{m}</button>)}</div>
            </div>

            <div><span className="mb-1.5 block text-[11px] font-bold tracking-wider text-slate-500">COMPARE</span>
              <div className="flex rounded-full bg-[#F5F5F4] p-1">{(["Off","Avg"] as const).map(v=><button key={v} onClick={()=>setCompare(v)} className={`flex-1 rounded-full px-3 py-1.5 text-[12px] font-bold ${compare===v?"bg-white shadow text-black":"text-slate-500"}`}>{v==="Off"?"Off": "vs 2012–2026 Avg"}</button>)}</div>
            </div>
          </div>
          <p className="mt-4 rounded-xl bg-[#FFFBF5] px-3 py-2.5 text-[13px] leading-5 text-slate-600">Showing harmonized history for <b className="text-slate-900">{countryName}</b> — MODIS + VIIRS snapped to 1km grid. All charts below use <b className="text-slate-900">{metric}</b>, not raw points. <span className="text-slate-400">Tap a yearly bar to change the selected year.</span></p>
        </section>

        {/* SECTION 2 */}
        <div className="mt-6 flex items-center justify-between gap-3"><h2 className="text-[11px] font-extrabold tracking-[0.16em] text-slate-500">2 • HARMONIZED TRENDS FOR THIS COUNTRY — YEAR, CHART &amp; VERDICT UPDATE TOGETHER</h2><span className="hidden sm:block text-[12px] font-semibold text-orange-700">{selectedYear} selected</span></div>

        {/* KPIs */}
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-[#E7E5E4] bg-white p-4 shadow-sm"><div className="flex justify-between"><p className="text-[11px] font-bold tracking-wider text-slate-500">TOTAL ACTIVE FIRE CELLS</p><Activity className="h-4 w-4 text-orange-600"/></div><p className="tabular mt-3 text-[30px] leading-none font-extrabold">{fmt(selectedCells)}</p><p className="mt-2 flex items-center gap-1 text-[12px] font-bold text-emerald-600"><ArrowUpRight className="h-3.5 w-3.5"/>{yoy>=0?"+":""}{yoy.toFixed(1)}% <span className="font-medium text-slate-400">vs {selectedYear-1}</span></p><p className="mt-1 text-[12px] text-slate-400">{selectedYear} • {countryName}</p></div>
          <div className="rounded-2xl border border-[#E7E5E4] bg-white p-4 shadow-sm"><div className="flex justify-between"><p className="text-[11px] font-bold tracking-wider text-slate-500">TOTAL FRP</p><Zap className="h-4 w-4 text-orange-600"/></div><p className="tabular mt-3 text-[30px] leading-none font-extrabold">{(totalFRP/1000000).toFixed(1)}M <span className="text-[15px] text-slate-400">MW</span></p><p className="mt-2 flex items-center gap-1 text-[12px] font-bold text-emerald-600"><ArrowUpRight className="h-3.5 w-3.5"/>+24.1% <span className="font-medium text-slate-400">vs prior year</span></p><p className="mt-1 text-[12px] text-slate-400">Summed per 1 km cell</p></div>
          <div className="rounded-2xl border border-[#E7E5E4] bg-white p-4 shadow-sm"><div className="flex justify-between"><p className="text-[11px] font-bold tracking-wider text-slate-500">PEAK DAY</p><CalendarDays className="h-4 w-4 text-orange-600"/></div><p className="mt-3 text-[19px] leading-tight font-extrabold">Sep {peakDayNum}, {selectedYear}</p><p className="tabular mt-1 text-[14px] font-bold text-orange-700">{fmt(peakCells)} cells</p><p className="mt-2 text-[12px] text-slate-400">Highest single-day cell count</p></div>
          <div className="rounded-2xl border border-[#E7E5E4] bg-white p-4 shadow-sm"><div className="flex justify-between"><p className="text-[11px] font-bold tracking-wider text-slate-500">VIIRS-ONLY %</p><Eye className="h-4 w-4 text-orange-600"/></div><p className="tabular mt-3 text-[30px] leading-none font-extrabold">{viirsPct.toFixed(1)}%</p><p className="mt-2 text-[12px] font-semibold text-slate-600">small fires MODIS missed <span className="ml-1 font-bold text-emerald-600">+2.4 pts</span></p><p className="mt-1 text-[12px] text-slate-400">Share of harmonized cells</p></div>
        </div>

        {/* VERDICT */}
        <div className="mt-3 overflow-hidden rounded-2xl border border-orange-200 bg-gradient-to-r from-[#FDE68A] via-[#FED7AA] to-[#FFF7ED] px-4 py-3.5 sm:flex items-center justify-between gap-4">
          <div><p className="text-[11px] font-extrabold tracking-[0.14em] text-orange-900">VERDICT</p><p className="mt-0.5 text-[15px] sm:text-[16px] font-extrabold text-[#431407]">In {countryName}, {selectedYear} — {diffPct>=0?"Above-average":"Below-average"} fire year • {Math.abs(diffPct).toFixed(0)}% {diffPct>=0?"above":"below"} 2012–2026 average • Peak in September</p></div>
          <span className="mt-2 sm:mt-0 inline-flex shrink-0 items-center gap-1 rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-bold text-orange-900"><TrendingUp className="h-4 w-4"/>{selectedYear} in focus</span>
        </div>

        {/* CHARTS ROW 1 */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <section className="lg:col-span-2 rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[11px] font-bold tracking-[0.14em] text-slate-500">YEARLY TREND — {metric.toUpperCase()}</p><p className="mt-1 text-[17px] font-extrabold">Every year, one bar • tap to select</p></div><span className="rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-bold text-orange-700">2012–2026</span></div>
            <div className="relative mt-5 h-[220px] sm:h-[250px]">
              {compare==="Avg" && <><div className="absolute left-0 right-0 border-t-2 border-dashed border-slate-400" style={{bottom:`${(avgMetric/maxMetric)*100}%`}} /><span className="absolute right-0 rounded bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-500 border border-slate-200" style={{bottom:`calc(${(avgMetric/maxMetric)*100}% + 4px)`}}>AVG {metricLabel(avgMetric, metric)}</span></>}
              <div className="absolute inset-0 flex items-end gap-[6px] sm:gap-2">
                {visibleYears.map(d=>{
                  const v = metricValue(d.cells, metric); const h = Math.max(4, (v/maxMetric)*100); const active = d.year===selectedYear;
                  return <button key={d.year} onClick={()=>setSelectedYear(d.year)} title={`${d.year}: ${metricLabel(v, metric)}`} className="group flex h-full flex-1 flex-col justify-end min-w-0">
                    <span className={`mb-1 hidden sm:block text-center text-[10px] font-bold ${active?"text-orange-700":"text-slate-400 opacity-0 group-hover:opacity-100"}`}>{compact(v)}</span>
                    <span className={`w-full rounded-t-md transition-all ${active?"bg-orange-600 shadow-[0_0_0_2px_#FED7AA]":"bg-[#FDBA74] hover:bg-orange-400"}`} style={{height:`${h}%`}} />
                    <span className={`mt-2 text-center text-[10px] sm:text-[11px] font-bold ${active?"text-orange-700":"text-slate-500"}`}>{String(d.year).slice(2)}</span>
                  </button>;
                })}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-slate-500"><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-orange-600 align-middle"/>Selected year</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#FDBA74] align-middle"/>Other years</span>{compare==="Avg" && <span><i className="mr-1 inline-block h-3 w-4 border-t-2 border-dashed border-slate-400 align-middle"/>2012–2026 average</span>}<span className="ml-auto">Showing {visibleYears.length} of 15 years</span></div>
            <p className="mt-3 rounded-xl bg-[#FFFBF5] px-3 py-2 text-[13px] text-slate-600"><b className="text-slate-900">{selectedYear}:</b> {fmt(selectedCells)} cells • {metricLabel(metricValue(selectedCells, metric), metric)}. {selectedYear===2018 ? "The standout year in this window." : "Tap 2018 to return to the highlighted peak."}</p>
          </section>

          <section className="rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-5 shadow-sm">
            <p className="text-[11px] font-bold tracking-[0.14em] text-slate-500">SENSOR SPLIT — {selectedYear}</p><h3 className="mt-1 text-[17px] font-extrabold">Where did cells come from?</h3>
            <div className="relative mx-auto mt-5 h-[168px] w-[168px]"><div className="h-full w-full rounded-full" style={{background:`conic-gradient(#EA580C 0 ${bothPct}%, #F59E0B ${bothPct}% ${bothPct+viirsPct}%, #FDE68A ${bothPct+viirsPct}% 100%)`}} /><div className="absolute inset-[42px] grid place-items-center rounded-full bg-white text-center shadow-inner"><div><p className="text-[22px] leading-none font-extrabold">{compact(selectedCells)}</p><p className="mt-1 text-[11px] font-semibold text-slate-400">cells</p></div></div></div>
            <div className="mt-5 space-y-2.5 text-[13px]"><div className="flex items-center justify-between"><span className="flex items-center gap-2"><i className="h-3 w-3 rounded-full bg-[#EA580C]"/>Both sensors</span><b>{bothPct.toFixed(1)}%</b></div><div className="flex items-center justify-between"><span className="flex items-center gap-2"><i className="h-3 w-3 rounded-full bg-amber-500"/>VIIRS-only</span><b>{viirsPct.toFixed(1)}%</b></div><div className="flex items-center justify-between"><span className="flex items-center gap-2"><i className="h-3 w-3 rounded-full bg-[#FDE68A]"/>MODIS-only</span><b>{modisPct.toFixed(1)}%</b></div></div>
            <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-[12px] leading-5 text-amber-900">VIIRS catches the smaller, cooler fires MODIS misses. That is why harmonizing matters.</p>
          </section>
        </div>

        {/* ROW 2 */}
        <div className="mt-4 grid gap-4 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-5 shadow-sm">
            <p className="text-[11px] font-bold tracking-[0.14em] text-slate-500">SEASONALITY — MONTHLY, {selectedYear}</p><h3 className="mt-1 text-[17px] font-extrabold">Aug–Oct carries the year</h3>
            <div className="relative mt-5 h-[190px]"><div className="absolute inset-0 flex items-end gap-1.5 sm:gap-2">{monthly.map((v,i)=>(<div key={i} className="flex flex-1 flex-col justify-end"><div className="relative flex items-end justify-center"><span className="absolute -top-1 h-1.5 w-1.5 rounded-full bg-slate-400" style={{bottom:`${(monthly2017[i]/maxMonthly)*100}%`, top:"auto"}} title={`2017: ${fmt(monthly2017[i])}`}/><div className={`w-full rounded-t-md ${i>=7 && i<=9?"bg-orange-600":"bg-[#FDBA74]"}`} style={{height:`${Math.max(3,(v/maxMonthly)*100)}%`, minHeight:6}} /></div><span className="mt-2 text-center text-[10px] font-semibold text-slate-500">{MONTHS[i]}</span></div>))}</div></div>
            <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-slate-500"><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-orange-600 align-middle"/>{selectedYear} monthly cells</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-slate-400 align-middle"/>2017 overlay (dot)</span><span className="ml-auto font-bold text-slate-700">Peak: Sep • {fmt(monthly[8])}</span></div>
          </section>

          <section className="lg:col-span-2 rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-5 shadow-sm">
            <p className="text-[11px] font-bold tracking-[0.14em] text-slate-500">BURNING-ACTIVITY CALENDAR</p><h3 className="mt-1 text-[17px] font-extrabold">Fire days for {countryName}, {selectedYear}</h3>
            <div className="mt-4 overflow-x-clip"><div className="grid grid-cols-12 gap-1.5">{calendar.map((weeks,mi)=>(<div key={mi} className="space-y-1.5"><span className="block text-center text-[10px] font-bold text-slate-400">{MONTHS[mi][0]}</span>{weeks.map((c,wi)=>(<div key={wi} title={`${MONTHS[mi]} • week ${wi+1}`} className="aspect-square w-full rounded-[4px] border border-black/5" style={{background:c}} />))}</div>))}</div></div>
            <div className="mt-4 flex items-center justify-between text-[11px] font-semibold text-slate-500"><span>Less</span><span className="flex gap-1">{calendarColors.map(c=><i key={c} className="h-3 w-3 rounded-[3px] border border-black/5" style={{background:c}} />)}</span><span>More fire activity</span></div>
            <p className="mt-3 text-[12px] leading-5 text-slate-500">Each column is a month; each square is a week. Darker orange means more harmonized fire activity that week.</p>
          </section>
        </div>

        {/* BOTTOM */}
        <div className="mt-4 grid gap-4 lg:grid-cols-5">
          <section className="lg:col-span-3 rounded-2xl border border-[#E7E5E4] bg-white p-4 sm:p-5 shadow-sm overflow-x-clip">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-[11px] font-bold tracking-[0.14em] text-slate-500">TOP 10 PEAK DAYS — {countryName.toUpperCase()}, {selectedYear}</p><h3 className="mt-1 text-[17px] font-extrabold">The days that defined the season</h3></div><span className="rounded-full bg-[#FFFBF5] border border-[#E7E5E4] px-2.5 py-1 text-[11px] font-semibold text-slate-500">Tap a column to sort</span></div>
            <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-[13px]"><thead><tr className="border-b border-[#E7E5E4] text-[11px] tracking-wider text-slate-500"><th className="py-2 pr-2">#</th><th className="py-2 pr-2">{sortHeader("DATE","date")}</th><th className="py-2 pr-2 text-right">{sortHeader("ACTIVE CELLS","cells")}</th><th className="py-2 pr-2 text-right">{sortHeader("TOTAL FRP","frp")}</th><th className="py-2 text-right">{sortHeader("MAX FRP","max")}</th></tr></thead><tbody>{peakDays.map((r,i)=>(<tr key={r.date} onClick={()=>setSelectedDay(i)} className={`cursor-pointer border-b border-[#F5F5F4] last:border-0 hover:bg-orange-50/60 ${selectedDay===i?"bg-orange-50":""}`}><td className="py-2.5 pr-2 font-bold text-slate-400">{String(i+1).padStart(2,"0")}</td><td className="py-2.5 pr-2 font-semibold">{r.date}</td><td className="tabular py-2.5 pr-2 text-right font-bold">{fmt(r.cells)}</td><td className="tabular py-2.5 pr-2 text-right text-slate-600">{fmt(r.frp)}</td><td className="tabular py-2.5 text-right text-slate-600">{fmt(r.max)}</td></tr>))}</tbody></table></div>
            <p className="mt-3 text-[12px] text-slate-400">Selected row: <b className="text-slate-700">{peakDays[selectedDay]?.date}</b> — {fmt(peakDays[selectedDay]?.cells||0)} cells. Tap another row to highlight it.</p>
          </section>

          <section className="lg:col-span-2 rounded-2xl border border-[#E7E5E4] bg-[#FFFBF5] p-4 sm:p-5">
            <p className="text-[11px] font-extrabold tracking-[0.16em] text-slate-500">METHODOLOGY — HOW THIS WAS HARMONIZED</p>
            <div className="mt-3 space-y-3 text-[13px] leading-6 text-slate-600">
              <p><b className="text-slate-900">Included:</b> MODIS confidence ≥30%, VIIRS nominal/high only, type=0 vegetation only.</p>
              <p><b className="text-slate-900">Snapped:</b> to 0.01° grid (~1.11 km). Grouped by (grid_cell, local_solar_date). FRP summed per cell.</p>
              <p><b className="text-slate-900">Scaling for pre-2012:</b> total / MODIS cells = 3.10 for Brazil 2018.</p>
            </div>
            <div className="mt-4 rounded-xl bg-white border border-[#E7E5E4] p-3"><p className="text-[11px] font-bold tracking-wider text-slate-500">READ IT AS</p><p className="mt-1 text-[13px] leading-5 text-slate-600">One cell = one 1 km square with fire on one local solar day. Not raw satellite points.</p></div>
          </section>
        </div>

        <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-slate-400"><span>Mockup data — 2018 real from harmonized_active_fire_cells.csv, other years illustrative</span><span>PlumeRoute • Harmonized tab mockup</span></footer>
        </>)}
      </main>
    </div>
  );
}
