import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Papa from 'papaparse';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Legend,
  LineChart, Line, ComposedChart,
} from 'recharts';
import { SpeedInsights } from '@vercel/speed-insights/react';

// ─── PHYSICAL CONSTANTS ───────────────────────────────────────────────────────
const ETA_CHARGE    = 0.97;
const ETA_DISCHARGE = 0.97;
const C_RATE        = 0.5;   // max (dis)charge rate [1/h]
const DT            = 0.25;  // 15-min interval [h]
const OFF_PEAK      = (h) => h < 7 || h >= 22; // night window for proactive charge

// ─── BATTERY PRICE CURVE (updated 2025 Swiss market) ─────────────────────────
const DEFAULT_PRICE_ANCHORS = [
  { kwh: 5,    chfPerKwh: 1200 },
  { kwh: 20,   chfPerKwh: 950  },
  { kwh: 50,   chfPerKwh: 780  },
  { kwh: 100,  chfPerKwh: 650  },
  { kwh: 200,  chfPerKwh: 580  },
  { kwh: 500,  chfPerKwh: 500  },
  { kwh: 1000, chfPerKwh: 450  },
];

function batteryPriceFromCurve(kwh, anchors, customBattery) {
  if (customBattery?.kwh > 0 && customBattery?.price > 0 && Math.abs(kwh - customBattery.kwh) < 1)
    return customBattery.price;
  if (kwh <= 0) return 0;
  const s = [...anchors].sort((a, b) => a.kwh - b.kwh);
  if (kwh <= s[0].kwh) return kwh * s[0].chfPerKwh;
  if (kwh >= s[s.length - 1].kwh) return kwh * s[s.length - 1].chfPerKwh;
  for (let i = 0; i < s.length - 1; i++) {
    if (kwh >= s[i].kwh && kwh <= s[i + 1].kwh) {
      const t = (kwh - s[i].kwh) / (s[i + 1].kwh - s[i].kwh);
      return kwh * (s[i].chfPerKwh + t * (s[i + 1].chfPerKwh - s[i].chfPerKwh));
    }
  }
  return kwh * s[s.length - 1].chfPerKwh;
}

function buildPriceCurveDisplay(anchors, maxKwh = 500) {
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const kwh = Math.round((maxKwh / 80) * i);
    pts.push({ kwh, totalPrice: Math.round(batteryPriceFromCurve(kwh, anchors, null)) });
  }
  return pts;
}

// ─── ROI CALCULATION ──────────────────────────────────────────────────────────
// Cumulative payback with electricity inflation + power tariff escalation
function computeRoiWithInflation(invest, baseSavings, inflation, esc1to5, esc6to10) {
  if (invest <= 0 || baseSavings <= 0) return null;
  let cum = 0;
  for (let yr = 1; yr <= 40; yr++) {
    const infMult = Math.pow(1 + inflation / 100, yr - 1);
    const escMult = yr <= 5
      ? Math.pow(1 + esc1to5 / 100, yr - 1)
      : Math.pow(1 + esc1to5 / 100, 4) * Math.pow(1 + esc6to10 / 100, yr - 5);
    const s = baseSavings * infMult * escMult;
    cum += s;
    if (cum >= invest) {
      const prev = cum - s;
      return +(yr - 1 + (invest - prev) / s).toFixed(2);
    }
  }
  return null; // > 40 years
}

// ROI% = économies annuelles / investissement initial × 100
function computeRoiPct(invest, annualSavings) {
  if (invest <= 0 || annualSavings <= 0) return null;
  return +((annualSavings / invest) * 100).toFixed(1);
}

// ─── PROFILE DETECTION ────────────────────────────────────────────────────────
// Determines whether dataset is better suited for peak shaving or autoconso.
function detectProfile(data) {
  if (!data?.length) return null;
  let pvKWh = 0, consoKWh = 0, maxNetKW = 0, surplusKWh = 0;
  for (const r of data) {
    pvKWh    += r.pv;
    consoKWh += r.conso;
    const kw = (r.conso - r.pv) / DT;
    if (kw > maxNetKW) maxNetKW = kw;
    if (r.pv > r.conso) surplusKWh += (r.pv - r.conso);
  }
  const pvRatio      = pvKWh / Math.max(1, consoKWh);
  const surplusRatio = surplusKWh / Math.max(1, pvKWh);
  const avgConsoKW   = consoKWh / (data.length * DT);
  const peakFactor   = maxNetKW / Math.max(0.1, avgConsoKW);

  // No meaningful PV → always peak shaving
  if (pvKWh < consoKWh * 0.05) return {
    mode: 'peakshaving', pvRatio, surplusRatio, peakFactor, maxNetKW, pvKWh, consoKWh,
    reason: `Production PV négligeable (${(pvRatio*100).toFixed(0)}% de la conso)`
  };

  const acScore = pvRatio * 0.5 + surplusRatio * 0.5;
  const psScore = Math.min(1, (peakFactor - 2) / 8) * (1 - Math.min(1, pvRatio * 1.5));

  if (acScore > psScore * 1.3) return {
    mode: 'autoconso', pvRatio, surplusRatio, peakFactor, maxNetKW, pvKWh, consoKWh,
    reason: `PV important (${(pvRatio*100).toFixed(0)}% de la conso) avec ${(surplusRatio*100).toFixed(0)}% de surplus exporté`
  };
  if (psScore > acScore * 1.3) return {
    mode: 'peakshaving', pvRatio, surplusRatio, peakFactor, maxNetKW, pvKWh, consoKWh,
    reason: `Pics de demande élevés (facteur ${peakFactor.toFixed(1)}×)`
  };
  return {
    mode: 'mixed', pvRatio, surplusRatio, peakFactor, maxNetKW, pvKWh, consoKWh,
    reason: `Profil mixte — les deux stratégies sont envisageables`
  };
}

// ─── SIMULATION ENGINE ────────────────────────────────────────────────────────
// CSV values = kWh per 15-min interval.  Power [kW] = energy [kWh] / DT
//
// Two EMS modes controlled by `emsMode`:
//   'peakshaving': predictive — proactive night charge, discharge above threshold
//   'autoconso':   passive    — PV surplus charge only, discharge for any net demand
//
// HP/HC tariff: hpHc = { enabled, hp, hc } — buy price depends on hour
//   Off-peak (22h–7h) = HC rate, peak hours = HP rate

function runSim(data, thresholdKW, capKWh, emsMode, hpHc) {
  const isHpHc = hpHc?.enabled && hpHc.hp > 0 && hpHc.hc > 0;
  const buyPrice = (h) => isHpHc ? (OFF_PEAK(h) ? hpHc.hc : hpHc.hp) : 0;

  // Fast path: no battery
  if (capKWh < 0.01) {
    let maxGridKW = 0;
    const monthlyPeaks = new Array(12).fill(0);
    let gridKWh = 0, injKWh = 0, pvKWh = 0, consoKWh = 0, selfConsKWh = 0, gridCostHH = 0;
    for (const r of data) {
      const netKW = (r.conso - r.pv) / DT;
      const gKW   = Math.max(0, netKW);
      const iKW   = Math.max(0, -netKW);
      pvKWh        += r.pv;
      consoKWh     += r.conso;
      selfConsKWh  += Math.min(r.pv, r.conso);
      gridKWh      += gKW * DT;
      injKWh       += iKW * DT;
      gridCostHH   += gKW * DT * buyPrice(r.hour);
      if (gKW > maxGridKW) maxGridKW = gKW;
      if (gKW > monthlyPeaks[r.month]) monthlyPeaks[r.month] = gKW;
    }
    const selfConsRate = pvKWh > 0 ? selfConsKWh / pvKWh : 0;
    const autarkyRate  = consoKWh > 0 ? selfConsKWh / consoKWh : 0;
    return { maxGridKW, monthlyPeaks, gridKWh, injKWh, pvKWh, consoKWh,
             selfConsKWh, selfConsRate, autarkyRate, gridCostHH };
  }

  let soc = capKWh * 0.5;
  let maxGridKW = 0;
  const monthlyPeaks = new Array(12).fill(0);
  let gridKWh = 0, injKWh = 0, pvKWh = 0, consoKWh = 0, gridCostHH = 0;
  let selfConsDirect = 0, selfConsBatt = 0;

  const n = data.length;

  // Look-ahead peak array — only needed for peak shaving EMS
  let lookAheadPeak = null;
  if (emsMode !== 'autoconso') {
    lookAheadPeak = data._lookAheadPeak;
    if (!lookAheadPeak) {
      lookAheadPeak = new Float64Array(n);
      const deq = [];
      for (let i = n - 1; i >= 0; i--) {
        const kw = (data[i].conso - data[i].pv) / DT;
        while (deq.length && deq[deq.length - 1] < i) deq.pop();
        while (deq.length && (data[deq[0]].conso - data[deq[0]].pv) / DT <= kw) deq.shift();
        deq.unshift(i);
        while (deq.length && deq[deq.length - 1] >= i + 16) deq.pop();
        lookAheadPeak[i] = (data[deq[0]].conso - data[deq[0]].pv) / DT;
      }
      data._lookAheadPeak = lookAheadPeak;
    }
  }

  for (let i = 0; i < n; i++) {
    const r      = data[i];
    const netKW  = (r.conso - r.pv) / DT;
    let   gridKW = 0;

    pvKWh    += r.pv;
    consoKWh += r.conso;

    if (emsMode === 'autoconso') {
      // ── PASSIVE EMS: discharge covers any net demand, charge from surplus ──
      if (netKW > 0) {
        // Discharge to cover load (no threshold — discharge for any demand)
        const maxDis  = Math.min(soc / DT / ETA_DISCHARGE, capKWh * C_RATE);
        const dis     = Math.min(netKW, maxDis);
        soc          -= dis * DT * ETA_DISCHARGE;
        gridKW        = netKW - dis;
        selfConsDirect += Math.min(r.pv, r.conso);
        selfConsBatt   += dis * DT;
      } else if (netKW < 0) {
        // Charge from PV surplus
        const surplus = -netKW;
        const maxCh   = Math.min((capKWh - soc) / DT / ETA_CHARGE, capKWh * C_RATE);
        const ch      = Math.min(surplus, maxCh);
        soc          += ch * DT * ETA_CHARGE;
        injKWh       += (surplus - ch) * DT;
        gridKW        = 0;
        selfConsDirect += r.conso;
      } else {
        selfConsDirect += Math.min(r.pv, r.conso);
      }
    } else {
      // ── PREDICTIVE EMS: peak shaving with proactive night charging ──────────
      if (netKW > thresholdKW) {
        // Priority 1: discharge to shave peak above threshold
        const needed  = netKW - thresholdKW;
        const maxDis  = Math.min(soc / DT / ETA_DISCHARGE, capKWh * C_RATE);
        const dis     = Math.min(needed, maxDis);
        soc          -= dis * DT * ETA_DISCHARGE;
        gridKW        = netKW - dis;
        selfConsDirect += Math.min(r.pv, r.conso);
        selfConsBatt   += dis * DT;
      } else if (netKW < 0) {
        // Priority 2: charge from PV surplus
        const surplus = -netKW;
        const maxCh   = Math.min((capKWh - soc) / DT / ETA_CHARGE, capKWh * C_RATE);
        const ch      = Math.min(surplus, maxCh);
        soc          += ch * DT * ETA_CHARGE;
        injKWh       += (surplus - ch) * DT;
        gridKW        = 0;
        selfConsDirect += r.conso;
      } else {
        // Priority 3: proactive night charge if peak coming and SoC low
        // Also: HC arbitrage if HP/HC enabled
        const offPk        = OFF_PEAK(r.hour);
        const upcoming     = lookAheadPeak[i];
        const gap          = Math.max(0, upcoming - thresholdKW);
        const neededSoC    = Math.min(capKWh, (gap * DT / ETA_DISCHARGE) * 1.2);
        const hcArbitrage  = isHpHc && offPk && soc < capKWh * 0.25;

        if (offPk && ((gap > 0 && soc < neededSoC) || hcArbitrage)) {
          const target  = Math.max(neededSoC, hcArbitrage ? capKWh * 0.3 : 0);
          const wantKW  = Math.min((target - soc) / DT / ETA_CHARGE, capKWh * C_RATE);
          const ch      = Math.max(0, wantKW);
          soc          += ch * DT * ETA_CHARGE;
          gridKW        = Math.max(0, netKW) + ch;
        } else {
          gridKW = Math.max(0, netKW);
        }
        selfConsDirect += Math.min(r.pv, r.conso);
      }
    }

    soc    = Math.max(0, Math.min(capKWh, soc));
    gridKW = Math.max(0, gridKW);
    if (gridKW > maxGridKW) maxGridKW = gridKW;
    if (gridKW > monthlyPeaks[r.month]) monthlyPeaks[r.month] = gridKW;
    gridKWh    += gridKW * DT;
    gridCostHH += gridKW * DT * buyPrice(r.hour);
  }

  const selfConsKWh  = Math.min(pvKWh, selfConsDirect + selfConsBatt);
  const selfConsRate = pvKWh > 0 ? selfConsKWh / pvKWh : 0;
  const autarkyRate  = consoKWh > 0 ? selfConsKWh / consoKWh : 0;
  return { maxGridKW, monthlyPeaks, gridKWh, injKWh, pvKWh, consoKWh,
           selfConsKWh, selfConsRate, autarkyRate, gridCostHH };
}

// ─── BATTERY SIZING (binary search) ──────────────────────────────────────────
function minBatteryPS(data, thresholdKW, baseMaxKW, hpHc) {
  const huge = runSim(data, thresholdKW, baseMaxKW * 24, 'peakshaving', hpHc);
  if (huge.maxGridKW > thresholdKW * 1.005) return Infinity;
  let lo = 0, hi = baseMaxKW * 24;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    runSim(data, thresholdKW, mid, 'peakshaving', hpHc).maxGridKW <= thresholdKW * 1.005
      ? (hi = mid) : (lo = mid);
  }
  return hi;
}

// ─── PEAK SHAVING CURVE ───────────────────────────────────────────────────────
// For each % reduction 0→99, finds minimum battery and computes all savings.
// Power tariff: Swiss method = Σ(monthly peaks) × CHF/kW (not annual max × 12)
function computePSCurve(data, prixAchat, prixVente, prixPuissance, hpHc) {
  const isHpHc = hpHc?.enabled && hpHc.hp > 0 && hpHc.hc > 0;

  // Cache look-ahead once
  if (!data._lookAheadPeak) {
    const n = data.length, lap = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let mx = 0;
      for (let j = i; j < Math.min(n, i + 16); j++) {
        const kw = (data[j].conso - data[j].pv) / DT;
        if (kw > mx) mx = kw;
      }
      lap[i] = mx;
    }
    data._lookAheadPeak = lap;
  }

  const baseMaxKW = (() => { let m=0; for (const r of data) { const k=(r.conso-r.pv)/DT; if(k>m)m=k; } return m; })();
  const base = runSim(data, baseMaxKW * 100, 0, 'peakshaving', hpHc);

  const basePeaks = new Array(12).fill(0);
  for (const r of data) { const k=(r.conso-r.pv)/DT; if(k>basePeaks[r.month]) basePeaks[r.month]=k; }
  const basePuiCost = basePeaks.reduce((s, p) => s + p * prixPuissance, 0);

  // Effective avg buy rate when HP/HC enabled
  const avgBuy = isHpHc && base.gridCostHH > 0
    ? base.gridCostHH / Math.max(1, base.gridKWh)
    : prixAchat;

  const points = [];
  for (let pct = 0; pct <= 99; pct++) {
    const threshold = baseMaxKW * (1 - pct / 100);
    const cap = minBatteryPS(data, threshold, baseMaxKW, hpHc);
    if (!isFinite(cap)) break;

    const sim = runSim(data, threshold, cap, 'peakshaving', hpHc);
    const savPui  = basePuiCost - sim.monthlyPeaks.reduce((s, p) => s + p * prixPuissance, 0);
    const savEn   = isHpHc
      ? (base.gridCostHH - sim.gridCostHH)
      : (base.gridKWh - sim.gridKWh) * prixAchat;
    const lossInj = Math.max(0, (base.injKWh - sim.injKWh) * prixVente);
    const annualSavings = savPui + savEn - lossInj;

    points.push({
      rate: pct, batterySizeKWh: Math.round(cap * 10) / 10,
      thresholdKW: Math.round(threshold * 10) / 10,
      savPui:  Math.round(savPui),
      savEn:   Math.round(savEn),
      lossInj: Math.round(lossInj),
      annualSavings: Math.round(annualSavings),
      selfConsRate: Math.round(sim.selfConsRate * 1000) / 10,
      autarkyRate:  Math.round(sim.autarkyRate  * 1000) / 10,
    });
  }
  return { points, baseMaxKW, base, basePeaks, basePuiCost };
}

// ─── AUTOCONSOMMATION CURVE ───────────────────────────────────────────────────
// Tests battery sizes from 0 to 3× daily PV surplus and computes AC-specific savings.
// No peak shaving threshold — battery covers ALL net demand (passive EMS).
function computeACCurve(data, prixAchat, prixVente, prixPuissance, hpHc) {
  const isHpHc = hpHc?.enabled && hpHc.hp > 0 && hpHc.hc > 0;
  const base   = runSim(data, 99999, 0, 'autoconso', hpHc);

  const basePeaks = new Array(12).fill(0);
  for (const r of data) { const k=(r.conso-r.pv)/DT; if(k>basePeaks[r.month]) basePeaks[r.month]=k; }
  const basePuiCost = basePeaks.reduce((s, p) => s + p * prixPuissance, 0);

  // Daily PV surplus → optimal battery range
  let surplusKWh = 0;
  for (const r of data) surplusKWh += Math.max(0, r.pv - r.conso);
  const dailySurplus = surplusKWh / (data.length / 96);
  const maxCap       = Math.min(1000, Math.max(50, dailySurplus * 4));

  // Test 40 sizes for smooth curve
  const points = [];
  for (let step = 0; step <= 40; step++) {
    const cap = (maxCap / 40) * step;
    const sim = runSim(data, 99999, cap, 'autoconso', hpHc);

    const savEn  = isHpHc
      ? (base.gridCostHH - sim.gridCostHH)
      : (base.gridKWh - sim.gridKWh) * prixAchat;
    // Also capture any incidental peak reduction (passive EMS can reduce some peaks)
    const savPui = basePuiCost - sim.monthlyPeaks.reduce((s, p) => s + p * prixPuissance, 0);
    const lossInj = Math.max(0, (base.injKWh - sim.injKWh) * prixVente);
    const annualSavings = Math.max(0, savEn + savPui - lossInj);

    points.push({
      capKWh:        Math.round(cap * 10) / 10,
      selfConsRate:  Math.round(sim.selfConsRate * 1000) / 10,
      autarkyRate:   Math.round(sim.autarkyRate  * 1000) / 10,
      savEn:         Math.round(savEn),
      savPui:        Math.round(savPui),
      lossInj:       Math.round(lossInj),
      annualSavings: Math.round(annualSavings),
      monthlyPeaks:  sim.monthlyPeaks,
      maxGridKW:     sim.maxGridKW,
    });
  }

  // Return all points — optimal is computed in the React layer using real price/ROI context
  return { points, base, basePeaks, basePuiCost };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rows = [];
  for (const r of result.data) {
    const keys = Object.keys(r);
    let ts = null, pv = null, conso = null;
    for (const k of keys) {
      const kl = k.toLowerCase();
      if (ts    === null && (kl.includes('time') || kl.includes('date') || kl === 'timestamp')) ts = r[k];
      if (pv    === null && (kl.includes('pv') || kl.includes('prod') || kl.includes('solar')) && typeof r[k] === 'number') pv = r[k];
      if (conso === null && (kl.includes('conso') || kl.includes('load') || kl.includes('demand') || kl.includes('consumption')) && typeof r[k] === 'number') conso = r[k];
    }
    if (pv === null || conso === null) {
      const num = keys.filter(k => typeof r[k] === 'number');
      if (num.length >= 2) { pv = r[num[0]]; conso = r[num[1]]; }
    }
    if (pv === null || conso === null) continue;
    let month = 0, hour = 0;
    if (ts) { const d = new Date(ts); if (!isNaN(d)) { month = d.getMonth(); hour = d.getHours(); } }
    rows.push({ pv: Math.max(0, pv), conso: Math.max(0, conso), month, hour });
  }
  return rows;
}

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
function generateDemoData() {
  const rows = [], start = new Date('2025-01-01T00:00:00');
  for (let i = 0; i < 365 * 96; i++) {
    const d = new Date(start.getTime() + i * 15 * 60000);
    const month = d.getMonth(), hour = d.getHours() + d.getMinutes() / 60;
    const sH = 4 + 3 * Math.sin((Math.PI * month) / 11);
    let pvKW = 0;
    if (Math.abs(hour - 12.5) < sH) {
      const x = (hour - 12.5) / sH;
      pvKW = Math.max(0, (8 + 5 * Math.sin((Math.PI * month) / 11)) * (1 - x * x) + (Math.random() - 0.5) * 0.5);
    }
    const base = 3 + Math.sin((Math.PI * month) / 5) * 0.5;
    const mP = hour >= 7 && hour <= 9  ? 2.5 * Math.exp(-0.5 * ((hour - 8) / 0.7) ** 2) : 0;
    const eP = hour >= 17 && hour <= 20 ? 3   * Math.exp(-0.5 * ((hour - 18.5) / 0.8) ** 2) : 0;
    const isWD = d.getDay() >= 1 && d.getDay() <= 5;
    const spike = isWD && hour >= 8 && hour <= 18
      ? 10 * Math.exp(-0.5 * ((hour - 13) / 2) ** 2) * (Math.floor(i / 96) % 3 === 0 ? 1 : 0.25) : 0;
    const cKW = Math.max(0, base + mP + eP + spike + (Math.random() - 0.5) * 0.5);
    rows.push({ pv: pvKW * DT, conso: cKW * DT, month, hour: d.getHours() });
  }
  return rows;
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:#f0f4f8; --bg2:#e8eef5; --surface:#fff; --surface2:#f7fafc;
    --border:#dde4ed; --border2:#c8d4e3;
    --text:#1a2535; --text2:#3d5166; --muted:#7a90a8;
    --green:#0d9f6e; --green-l:#e6f7f2;
    --blue:#1a6fbf; --blue-l:#e8f1fb;
    --teal:#0891b2; --teal-l:#e0f5fb;
    --amber:#d97706; --amber-l:#fef3c7;
    --red:#dc2626; --red-l:#fee2e2;
    --purple:#7c3aed; --purple-l:#ede9fe;
    --shadow-s:0 1px 3px rgba(26,37,53,.08),0 1px 2px rgba(26,37,53,.04);
    --r:12px; --font-h:'Plus Jakarta Sans',sans-serif; --font-b:'Inter',sans-serif;
  }
  body{background:var(--bg);color:var(--text);font-family:var(--font-b);font-size:14px;line-height:1.5;}
  .app{min-height:100vh;}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:0 36px;height:60px;display:flex;align-items:center;gap:14px;box-shadow:var(--shadow-s);position:sticky;top:0;z-index:10;}
  .hdr-logo{width:36px;height:36px;background:linear-gradient(135deg,#0d9f6e,#1a6fbf);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
  .hdr-title{font-family:var(--font-h);font-size:16px;font-weight:700;}
  .hdr-sub{font-size:12px;color:var(--muted);margin-left:2px;}
  .hdr-badge{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 12px;border-radius:20px;background:var(--green-l);border:1px solid #a7f3d0;color:var(--green);font-weight:500;}
  .hdr-badge::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--green);display:block;}
  /* Profile selection card */
  .profile-select{max-width:640px;margin:48px auto;}
  .profile-card{background:var(--surface);border:2px solid var(--border);border-radius:16px;padding:28px;cursor:pointer;transition:all .2s;box-shadow:var(--shadow-s);}
  .profile-card:hover{border-color:var(--green);transform:translateY(-2px);box-shadow:0 8px 24px rgba(13,159,110,.15);}
  .profile-card.selected{border-color:var(--green);background:var(--green-l);}
  .profile-icon{font-size:36px;margin-bottom:12px;}
  .profile-title{font-family:var(--font-h);font-size:17px;font-weight:700;margin-bottom:6px;}
  .profile-desc{font-size:13px;color:var(--muted);line-height:1.6;}
  .profile-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;margin-top:10px;}
  .profile-badge.suggested{background:var(--green-l);color:var(--green);border:1px solid #a7f3d0;}
  .profile-badge.alt{background:var(--blue-l);color:var(--blue);border:1px solid #bfdbfe;}
  .nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 36px;display:flex;}
  .nav-tab{padding:12px 18px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s;font-family:var(--font-b);}
  .nav-tab:hover{color:var(--text2);}
  .nav-tab.active{color:var(--green);border-bottom-color:var(--green);}
  .main{padding:28px 36px;max-width:1320px;}
  .upload-wrap{max-width:560px;margin:48px auto;}
  .upload-zone{border:2px dashed var(--border2);border-radius:16px;padding:48px 32px;text-align:center;cursor:pointer;transition:all .2s;background:var(--surface);box-shadow:var(--shadow-s);}
  .upload-zone:hover,.upload-zone.drag{border-color:var(--green);background:var(--green-l);}
  .uz-icon{font-size:40px;margin-bottom:14px;}
  .uz-title{font-family:var(--font-h);font-size:18px;font-weight:700;margin-bottom:8px;}
  .uz-sub{font-size:13px;color:var(--muted);line-height:1.7;}
  .uz-hint{margin-top:16px;display:inline-block;font-size:12px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:8px 16px;line-height:1.9;}
  .upload-or{text-align:center;color:var(--muted);font-size:12px;margin:16px 0;}
  .btn-outline{background:var(--surface);border:1.5px solid var(--green);color:var(--green);font-family:var(--font-b);font-size:13px;font-weight:500;padding:9px 22px;border-radius:8px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:7px;}
  .btn-outline:hover{background:var(--green);color:#fff;}
  .btn-primary{background:linear-gradient(135deg,#0d9f6e,#1a6fbf);border:none;color:#fff;font-family:var(--font-b);font-size:14px;font-weight:600;padding:12px 32px;border-radius:10px;cursor:pointer;transition:opacity .2s;width:100%;}
  .btn-primary:hover{opacity:.88;}
  .lbar{position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#0d9f6e,#1a6fbf,#0891b2);animation:lbar 1.5s ease-in-out infinite;z-index:99;}
  @keyframes lbar{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px;}
  .stats-3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px;}
  .scard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;box-shadow:var(--shadow-s);}
  .scard.green{border-left:3px solid var(--green);} .scard.blue{border-left:3px solid var(--blue);}
  .scard.teal{border-left:3px solid var(--teal);} .scard.amber{border-left:3px solid var(--amber);}
  .scard.purple{border-left:3px solid var(--purple);}
  .scard .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-weight:500;margin-bottom:8px;}
  .scard .val{font-family:var(--font-h);font-size:26px;font-weight:700;}
  .scard .unit{font-size:13px;color:var(--muted);font-weight:400;margin-left:3px;}
  .scard .sub{font-size:11px;color:var(--muted);margin-top:4px;}
  .scard.green .val{color:var(--green);} .scard.blue .val{color:var(--blue);} .scard.teal .val{color:var(--teal);}
  .sec{margin-bottom:24px;}
  .sec-title{font-family:var(--font-h);font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px;display:flex;align-items:center;gap:8px;}
  .sec-title .dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:22px;box-shadow:var(--shadow-s);}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  .three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;}
  .cfg-panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-s);}
  .cfg-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:24px;align-items:start;}
  .cfg-label{font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px;}
  .slider-row{display:flex;align-items:center;gap:14px;}
  .slider-row input[type=range]{flex:1;-webkit-appearance:none;height:4px;background:var(--bg2);border-radius:2px;outline:none;}
  .slider-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:var(--green);cursor:pointer;border:2px solid #fff;box-shadow:0 1px 4px rgba(13,159,110,.4);}
  .slider-val{font-family:var(--font-h);font-size:24px;font-weight:700;color:var(--green);min-width:62px;text-align:right;}
  .slider-sub{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.9;}
  .inp-group{display:flex;flex-direction:column;}
  .inp-row{display:flex;align-items:center;background:var(--surface2);border:1.5px solid var(--border);border-radius:8px;overflow:hidden;transition:border-color .15s;}
  .inp-row:focus-within{border-color:var(--green);}
  .inp-pfx{padding:9px 10px;font-size:12px;color:var(--muted);border-right:1px solid var(--border);white-space:nowrap;}
  .inp-row input{flex:1;background:none;border:none;color:var(--text);font-family:var(--font-b);font-size:13px;padding:9px 10px;outline:none;min-width:0;}
  .res-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
  .rcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px;box-shadow:var(--shadow-s);}
  .rcard.hl-green{background:var(--green-l);border-color:#a7f3d0;}
  .rcard.hl-blue{background:var(--blue-l);border-color:#bfdbfe;}
  .rcard.hl-amber{background:var(--amber-l);border-color:#fde68a;}
  .rcard.hl-purple{background:var(--purple-l);border-color:#c4b5fd;}
  .rcard .rl{font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;}
  .rcard .rv{font-family:var(--font-h);font-size:28px;font-weight:800;}
  .rcard.hl-green .rv{color:var(--green);} .rcard.hl-blue .rv{color:var(--blue);}
  .rcard.hl-amber .rv{color:var(--amber);} .rcard.hl-purple .rv{color:var(--purple);}
  .rcard .rs{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.6;}
  .roi-track{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;margin-top:10px;}
  .roi-fill{height:100%;border-radius:3px;transition:width .5s;}
  /* Before/After comparison cards */
  .compare-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}
  .compare-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px;box-shadow:var(--shadow-s);}
  .compare-card.after{border-color:#a7f3d0;background:var(--green-l);}
  .compare-title{font-family:var(--font-h);font-size:13px;font-weight:700;margin-bottom:14px;color:var(--text2);}
  .compare-title.after{color:var(--green);}
  .compare-row{display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px;}
  .compare-row .label{color:var(--muted);}
  .compare-row .value{font-weight:600;}
  /* Toggle */
  .toggle-row{display:flex;align-items:center;gap:10px;margin-bottom:16px;}
  .toggle{position:relative;width:40px;height:22px;flex-shrink:0;}
  .toggle input{opacity:0;width:0;height:0;}
  .toggle-slider{position:absolute;inset:0;background:var(--border2);border-radius:11px;cursor:pointer;transition:.2s;}
  .toggle-slider::before{content:'';position:absolute;width:16px;height:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;}
  .toggle input:checked + .toggle-slider{background:var(--green);}
  .toggle input:checked + .toggle-slider::before{transform:translateX(18px);}
  .toggle-label{font-size:13px;font-weight:500;color:var(--text2);}
  .tbl-wrap{overflow:hidden;border-radius:var(--r);border:1px solid var(--border);box-shadow:var(--shadow-s);}
  .tbl-scroll{overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  thead tr{background:var(--surface2);border-bottom:1px solid var(--border2);}
  th{padding:11px 16px;text-align:left;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;}
  tbody tr{border-bottom:1px solid var(--border);transition:background .1s;}
  tbody tr:hover{background:var(--surface2);}
  tbody tr.sel{background:var(--green-l) !important;}
  tbody tr.opt{background:var(--blue-l) !important;}
  td{padding:9px 16px;color:var(--text2);}
  td.acc{color:var(--green);font-weight:600;} td.blu{color:var(--blue);font-weight:600;}
  td.amb{color:var(--amber);font-weight:700;} td.red{color:var(--red);font-weight:700;}
  .computing{text-align:center;padding:80px 20px;}
  .computing .spin{font-size:36px;margin-bottom:16px;animation:spin 2s linear infinite;display:inline-block;}
  @keyframes spin{to{transform:rotate(360deg)}}
  .computing h3{font-family:var(--font-h);font-size:18px;font-weight:700;margin-bottom:6px;}
  .computing p{font-size:13px;color:var(--muted);}
  .info-box{background:var(--blue-l);border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;font-size:12px;color:var(--blue);line-height:1.7;margin-bottom:16px;}
  .warn-box{background:var(--amber-l);border:1px solid #fde68a;border-radius:10px;padding:12px 16px;font-size:12px;color:var(--amber);line-height:1.7;margin-bottom:16px;}
  @media(max-width:960px){.main,.hdr,.nav{padding-left:16px;padding-right:16px;}.stats,.stats-3{grid-template-columns:1fr 1fr;}.cfg-grid,.res-grid,.two-col,.three-col,.compare-grid{grid-template-columns:1fr;}}
`;

// ─── SHARED UI COMPONENTS ─────────────────────────────────────────────────────
const ChartTip = ({ active, payload, label, unit = '' }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#fff', border:'1px solid #dde4ed', borderRadius:10, padding:'10px 14px', boxShadow:'0 4px 12px rgba(26,37,53,.12)', fontSize:12 }}>
      <div style={{ color:'#7a90a8', marginBottom:6, fontWeight:500 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display:'flex', gap:8, alignItems:'center', color:'#1a2535', marginBottom:2 }}>
          <span style={{ width:8, height:8, borderRadius:'50%', background:p.color, display:'inline-block', flexShrink:0 }} />
          <span style={{ color:'#3d5166' }}>{p.name}:</span>
          <strong>{typeof p.value === 'number' ? p.value.toFixed(1) : p.value} {unit}</strong>
        </div>
      ))}
    </div>
  );
};

const fmt = (n) => (n != null ? Math.round(n).toLocaleString('fr-CH') : '—');

function DeferredInput({ value, onChange, ...props }) {
  const [local, setLocal] = useState(String(value ?? ''));
  useEffect(() => { setLocal(String(value ?? '')); }, [value]);
  const commit = () => {
    const n = parseFloat(local);
    if (!isNaN(n) && n !== value) onChange(n);
    else setLocal(String(value ?? ''));
  };
  return (
    <input {...props} value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(); e.target.blur(); } }} />
  );
}

// ─── BEFORE/AFTER COMPARISON WIDGET ──────────────────────────────────────────
function BeforeAfter({ base, sim, capKWh, prixPuissance, hpHc, prixAchat, label }) {
  const isHpHc = hpHc?.enabled && hpHc.hp > 0;
  const baseCostEn  = isHpHc ? base.gridCostHH : base.gridKWh * prixAchat;
  const simCostEn   = isHpHc ? sim.gridCostHH  : sim.gridKWh  * prixAchat;
  const basePuiCost = base.monthlyPeaks.reduce((s, p) => s + p * prixPuissance, 0);
  const simPuiCost  = sim.monthlyPeaks.reduce((s, p) => s + p * prixPuissance, 0);
  const savEn  = baseCostEn - simCostEn;
  const savPui = basePuiCost - simPuiCost;

  return (
    <div className="compare-grid">
      <div className="compare-card">
        <div className="compare-title">Situation avant batterie</div>
        <div className="compare-row"><span className="label">Puissance crête réseau</span><span className="value">{base.maxGridKW.toFixed(1)} kW</span></div>
        <div className="compare-row"><span className="label">Achat réseau annuel</span><span className="value">{fmt(base.gridKWh)} kWh</span></div>
        <div className="compare-row"><span className="label">Coût énergie annuel</span><span className="value" style={{ color:'var(--red)' }}>{fmt(baseCostEn)} CHF</span></div>
        <div className="compare-row"><span className="label">Coût puissance annuel</span><span className="value" style={{ color:'var(--red)' }}>{fmt(basePuiCost)} CHF</span></div>
      </div>
      <div className="compare-card after">
        <div className="compare-title after">Situation après batterie optimale</div>
        <div className="compare-row"><span className="label">Puissance crête réduite</span><span className="value" style={{ color:'var(--green)' }}>{sim.maxGridKW.toFixed(1)} kW</span></div>
        <div className="compare-row"><span className="label">Réduction pic</span><span className="value" style={{ color:'var(--green)' }}>{Math.round((1 - sim.maxGridKW / base.maxGridKW) * 100)}%</span></div>
        <div className="compare-row"><span className="label">Taille batterie</span><span className="value" style={{ color:'var(--blue)' }}>{capKWh.toFixed(0)} kWh ({(capKWh * C_RATE).toFixed(0)} kW)</span></div>
        <div className="compare-row"><span className="label">Économies annuelles</span><span className="value" style={{ color:'var(--green)' }}>{fmt(savEn + savPui)} CHF</span></div>
      </div>
    </div>
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Core state ──
  const [data,      setData]      = useState(null);
  const [fileName,  setFileName]  = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [computing, setComputing] = useState(false);
  const [drag,      setDrag]      = useState(false);

  // ── Profile selection flow ──
  // 'detecting' → profile shown, user picks mode → 'computing' → dashboard
  const [phase,       setPhase]       = useState('upload');  // 'upload'|'profile'|'computing'|'dashboard'
  const [profile,     setProfile]     = useState(null);
  const [analysisMode, setAnalysisMode] = useState(null);    // 'peakshaving'|'autoconso'

  // ── Computed results ──
  const [psCurve, setPsCurve] = useState(null);  // peak shaving curve
  const [acCurve, setAcCurve] = useState(null);  // autoconso curve

  // ── Tariff params ──
  const [prixPuissance, setPrixPuissance] = useState(12);
  const [prixAchat,     setPrixAchat]     = useState(0.22);
  const [prixVente,     setPrixVente]     = useState(0.08);
  const [hpHcEnabled,   setHpHcEnabled]   = useState(false);
  const [prixHP,        setPrixHP]        = useState(0.27);
  const [prixHC,        setPrixHC]        = useState(0.18);

  // ── Financial params ──
  const [inflation,  setInflation]  = useState(2.0);
  const [escal1to5,  setEscal1to5]  = useState(3.0);
  const [escal6to10, setEscal6to10] = useState(2.0);

  // ── Battery price ──
  const [priceAnchors,  setPriceAnchors]  = useState(DEFAULT_PRICE_ANCHORS);
  const [customBattery, setCustomBattery] = useState({ kwh: '', price: '' });

  // ── Scenario selection ──
  const [selectedRate, setSelectedRate] = useState(30);  // PS mode — committed, triggers sim
  const [sliderRate,   setSliderRate]   = useState(30);  // PS mode — live visual, no-lag
  const [selectedAcCap, setSelectedAcCap] = useState(null); // AC mode

  // ── Active tab ──
  const [tab, setTab] = useState('overview');

  const fileRef = useRef();
  const dataRef = useRef(null);

  // HP/HC config object
  const hpHc = useMemo(() => ({
    enabled: hpHcEnabled, hp: prixHP, hc: prixHC,
  }), [hpHcEnabled, prixHP, prixHC]);

  // ── Computation ──────────────────────────────────────────────────────────
  // returnTab: which tab to show after computation ('overview' default, 'params' for tariff changes)
  const runComputation = useCallback(async (rows, mode, pa, pv, pp, hh, returnTab = 'overview') => {
    setPhase('computing');
    await new Promise(r => setTimeout(r, 50));

    if (mode === 'peakshaving') {
      const result = await new Promise(resolve =>
        setTimeout(() => resolve(computePSCurve(rows, pa, pv, pp, hh)), 0)
      );
      // Find optimal rate (min payback period) and pre-position slider there
      let optRate = 30;
      let optRoi  = Infinity;
      for (const p of result.points) {
        const prix = batteryPriceFromCurve(p.batterySizeKWh, DEFAULT_PRICE_ANCHORS, null);
        const roi  = computeRoiWithInflation(prix, p.annualSavings, 2, 3, 2);
        if (roi !== null && roi < optRoi) { optRoi = roi; optRate = p.rate; }
      }
      const safeRate = Math.min(optRate, result.points[result.points.length - 1]?.rate ?? optRate);
      setPsCurve(result);
      setSelectedRate(safeRate);
      setSliderRate(safeRate);
    } else {
      const result = await new Promise(resolve =>
        setTimeout(() => resolve(computeACCurve(rows, pa, pv, pp, hh)), 0)
      );
      setAcCurve(result);
      // Optimal cap will be computed by acOptimal useMemo after state settles
      // Start with the midpoint of the curve as a sensible default
      const midPoint = result.points[Math.floor(result.points.length / 2)];
      setSelectedAcCap(midPoint?.capKWh ?? 0);
    }

    setPhase('dashboard');
    setTab(returnTab);
  }, []);

  // ── File handling ────────────────────────────────────────────────────────
  const handleFile = useCallback((file) => {
    if (!file) return;
    setFileName(file.name);
    setLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      const rows = parseCSV(e.target.result);
      if (rows.length < 100) {
        alert('Fichier trop court ou colonnes non reconnues.');
        setLoading(false);
        return;
      }
      setData(rows);
      dataRef.current = rows;
      const p = detectProfile(rows);
      setProfile(p);
      setLoading(false);
      setPhase('profile');
    };
    reader.readAsText(file);
  }, []);

  const handleDemo = useCallback(() => {
    setFileName('demo_données.csv');
    setLoading(true);
    setTimeout(() => {
      const rows = generateDemoData();
      setData(rows);
      dataRef.current = rows;
      const p = detectProfile(rows);
      setProfile(p);
      setLoading(false);
      setPhase('profile');
    }, 30);
  }, []);

  const handleReset = useCallback(() => {
    setData(null); setFileName(null); setProfile(null); setAnalysisMode(null);
    setPsCurve(null); setAcCurve(null); setPhase('upload');
    setLoading(false); setComputing(false); dataRef.current = null;
  }, []);

  const handleModeSelect = useCallback((mode) => {
    setAnalysisMode(mode);
    runComputation(dataRef.current, mode, prixAchat, prixVente, prixPuissance, hpHc);
  }, [runComputation, prixAchat, prixVente, prixPuissance, hpHc]);

  const handleTariffChange = useCallback((pa, pv, pp, hh) => {
    if (!dataRef.current || !analysisMode) return;
    // Stay on 'params' tab so user can keep editing tariffs without being sent back to overview
    runComputation(dataRef.current, analysisMode, pa, pv, pp, hh, 'params');
  }, [runComputation, analysisMode]);

  // ── Price helpers ────────────────────────────────────────────────────────
  const customBattValid = useMemo(() => {
    const k = parseFloat(customBattery.kwh), p = parseFloat(customBattery.price);
    return k > 0 && p > 0 ? { kwh: k, price: p } : null;
  }, [customBattery]);

  const getPrice = useCallback((kwh) =>
    batteryPriceFromCurve(kwh, priceAnchors, customBattValid),
    [priceAnchors, customBattValid]
  );

  // ── PS scenario ──────────────────────────────────────────────────────────
  const psScenario = useMemo(() => {
    if (!data || !psCurve) return null;
    const { points, baseMaxKW, base, basePeaks } = psCurve;
    const pt = points.find(p => p.rate === selectedRate) ?? points[points.length - 1];
    if (!pt) return null;
    const threshold = baseMaxKW * (1 - selectedRate / 100);
    const sim  = runSim(data, threshold, pt.batterySizeKWh, 'peakshaving', hpHc);
    const prix = getPrice(pt.batterySizeKWh);
    const roi  = computeRoiWithInflation(prix, pt.annualSavings, inflation, escal1to5, escal6to10);
    return { ...pt, ...sim, threshold, baseMaxKW, base, basePeaks, roi, prix };
  }, [data, psCurve, selectedRate, getPrice, inflation, escal1to5, escal6to10, hpHc]);

  // Optimal PS point (min ROI)
  const psOptimal = useMemo(() => {
    if (!psCurve) return null;
    let best = null;
    for (const p of psCurve.points) {
      const prix = getPrice(p.batterySizeKWh);
      const roi  = computeRoiWithInflation(prix, p.annualSavings, inflation, escal1to5, escal6to10);
      if (roi !== null && (best === null || roi < best.roi))
        best = { ...p, roi, prix };
    }
    return best;
  }, [psCurve, getPrice, inflation, escal1to5, escal6to10]);

  const psRoiCurve = useMemo(() => {
    if (!psCurve) return [];
    return psCurve.points.map(p => {
      const prix = getPrice(p.batterySizeKWh);
      const roi  = computeRoiWithInflation(prix, p.annualSavings, inflation, escal1to5, escal6to10);
      return { rate: p.rate, roi, savings: p.annualSavings, kwh: p.batterySizeKWh, prix: Math.round(prix) };
    });
  }, [psCurve, getPrice, inflation, escal1to5, escal6to10]);

  // ── AC optimal: min payback period (same logic as psOptimal) ────────────────
  const acOptimal = useMemo(() => {
    if (!acCurve) return null;
    let best = null;
    for (const p of acCurve.points) {
      if (p.capKWh <= 0) continue;
      const prix = getPrice(p.capKWh);
      const roi  = computeRoiWithInflation(prix, p.annualSavings, inflation, escal1to5, escal6to10);
      if (roi !== null && (best === null || roi < best.roi))
        best = { ...p, roi, prix };
    }
    // Fallback: if no ROI found (savings always 0), pick smallest battery
    return best ?? acCurve.points[1] ?? acCurve.points[0];
  }, [acCurve, getPrice, inflation, escal1to5, escal6to10]);

  // ── AC scenario ──────────────────────────────────────────────────────────
  const acScenario = useMemo(() => {
    if (!data || !acCurve || selectedAcCap === null) return null;
    const pt = acCurve.points.find(p => Math.abs(p.capKWh - selectedAcCap) < 1)
             ?? acOptimal ?? acCurve.points[0];
    if (!pt) return null;
    const sim  = runSim(data, 99999, pt.capKWh, 'autoconso', hpHc);
    const prix = getPrice(pt.capKWh);
    const roi  = computeRoiWithInflation(prix, pt.annualSavings, inflation, escal1to5, escal6to10);
    return { ...pt, ...sim, prix, roi };
  }, [data, acCurve, selectedAcCap, getPrice, inflation, escal1to5, escal6to10, hpHc]);

  // When acOptimal is freshly computed (after new file or tariff change), snap slider to it
  useEffect(() => {
    if (acOptimal) setSelectedAcCap(acOptimal.capKWh);
  }, [acOptimal?.capKWh]);

  const MONTHS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc'];

  const monthlyData = useMemo(() => {
    if (!psScenario) return [];
    return MONTHS.map((m, i) => ({
      month: m,
      avant: +psScenario.basePeaks[i].toFixed(1),
      apres: +psScenario.monthlyPeaks[i].toFixed(1),
    }));
  }, [psScenario]);

  // ── Tab definitions ──────────────────────────────────────────────────────
  const psTabs = [
    { id: 'overview', label: '🏠 Vue d\'ensemble' },
    { id: 'sizing',   label: '⚡ Dimensionnement' },
    { id: 'roi',      label: '📈 TRI & Économies' },
    { id: 'params',   label: '⚙️ Paramètres' },
  ];
  const acTabs = [
    { id: 'overview', label: '🏠 Vue d\'ensemble' },
    { id: 'ac-detail',label: '☀️ Autoconsommation' },
    { id: 'roi',      label: '📈 TRI' },
    { id: 'params',   label: '⚙️ Paramètres' },
  ];
  const currentTabs = analysisMode === 'autoconso' ? acTabs : psTabs;

  // ── Params panel (shared) ─────────────────────────────────────────────────
  const ParamsPanel = () => (
    <div style={{ maxWidth: 700 }}>
      <div className="card">
        <div style={{ fontFamily:'var(--font-h)', fontWeight:700, fontSize:15, marginBottom:20 }}>Paramètres tarifaires</div>

        {/* HP/HC toggle */}
        <div style={{ marginBottom:24 }}>
          <div className="toggle-row">
            <label className="toggle">
              <input type="checkbox" checked={hpHcEnabled} onChange={e => {
                const v = e.target.checked;
                setHpHcEnabled(v);
                handleTariffChange(prixAchat, prixVente, prixPuissance, { enabled:v, hp:prixHP, hc:prixHC });
              }}/>
              <span className="toggle-slider"/>
            </label>
            <span className="toggle-label">Tarification heure pleine / heure creuse (HP/HC)</span>
          </div>
          {hpHcEnabled && (
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginTop:12, padding:16, background:'var(--surface2)', borderRadius:10, border:'1px solid var(--border)' }}>
              {[
                { label:'Tarif HP (7h–22h)', val:prixHP, set:(v)=>{ setPrixHP(v); handleTariffChange(prixAchat, prixVente, prixPuissance, { enabled:true, hp:v, hc:prixHC }); } },
                { label:'Tarif HC (22h–7h)', val:prixHC, set:(v)=>{ setPrixHC(v); handleTariffChange(prixAchat, prixVente, prixPuissance, { enabled:true, hp:prixHP, hc:v }); } },
              ].map(p => (
                <div key={p.label}>
                  <div className="cfg-label">{p.label}</div>
                  <div className="inp-row">
                    <span className="inp-pfx">CHF</span>
                    <DeferredInput type="number" value={p.val} min={0} step={0.01} onChange={p.set}/>
                    <span className="inp-pfx" style={{ borderLeft:'1px solid var(--border)', borderRight:'none' }}>/kWh</span>
                  </div>
                </div>
              ))}
              <div style={{ gridColumn:'1/-1', fontSize:11, color:'var(--muted)' }}>
                Avec HP/HC : la batterie charge aussi en heures creuses pour arbitrage tarifaire.
                Les économies d'énergie utilisent le coût réel HP/HC.
              </div>
            </div>
          )}
        </div>

        {/* Flat tariffs */}
        <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
          {[
            { label:'Tarif d\'achat électricité', val:prixAchat, set:(v)=>{ setPrixAchat(v); handleTariffChange(v, prixVente, prixPuissance, hpHc); }, unit:'kWh', step:0.01, hide:hpHcEnabled },
            { label:'Tarif de vente (injection)', val:prixVente, set:(v)=>{ setPrixVente(v); handleTariffChange(prixAchat, v, prixPuissance, hpHc); }, unit:'kWh', step:0.01 },
            { label:'Tarif de puissance réseau',  val:prixPuissance, set:(v)=>{ setPrixPuissance(v); handleTariffChange(prixAchat, prixVente, v, hpHc); }, unit:'kW/mois', step:0.5 },
          ].filter(p => !p.hide).map(p => (
            <div key={p.label}>
              <div className="cfg-label">{p.label}</div>
              <div className="inp-row" style={{ maxWidth:200 }}>
                <span className="inp-pfx">CHF</span>
                <DeferredInput type="number" value={p.val} min={0} step={p.step} onChange={p.set}/>
                <span className="inp-pfx" style={{ borderLeft:'1px solid var(--border)', borderRight:'none' }}>/{p.unit}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Financial params */}
        <div style={{ marginTop:24, padding:16, background:'var(--surface2)', borderRadius:10, border:'1px solid var(--border)' }}>
          <div style={{ fontSize:12, fontWeight:600, color:'var(--text2)', marginBottom:14 }}>Paramètres financiers (TRI)</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            {[
              { label:'Inflation annuelle', val:inflation, set:setInflation, unit:'%/an' },
              { label:'Renchérissement puissance an. 1–5', val:escal1to5, set:setEscal1to5, unit:'%/an' },
              { label:'Renchérissement puissance an. 6–10', val:escal6to10, set:setEscal6to10, unit:'%/an' },
            ].map(p => (
              <div key={p.label}>
                <div className="cfg-label" style={{ fontSize:9 }}>{p.label}</div>
                <div className="inp-row">
                  <DeferredInput type="number" value={p.val} min={0} max={20} step={0.1} onChange={p.set}/>
                  <span className="inp-pfx" style={{ borderLeft:'1px solid var(--border)', borderRight:'none' }}>{p.unit}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Technical constants */}
        <div style={{ marginTop:16, padding:16, background:'var(--surface2)', borderRadius:10, border:'1px solid var(--border)' }}>
          <div style={{ fontSize:12, fontWeight:600, color:'var(--text2)', marginBottom:8 }}>Paramètres batterie (fixes)</div>
          <div style={{ fontSize:12, color:'var(--muted)', lineHeight:2 }}>
            C-Rate : <strong style={{ color:'var(--text)' }}>{C_RATE}</strong> &nbsp;·&nbsp;
            η charge : <strong style={{ color:'var(--text)' }}>{ETA_CHARGE * 100}%</strong> &nbsp;·&nbsp;
            η décharge : <strong style={{ color:'var(--text)' }}>{ETA_DISCHARGE * 100}%</strong>
          </div>
          <div style={{ fontSize:11, color:'var(--muted)', marginTop:8 }}>
            <strong>Facturation puissance :</strong> Σ(pic mensuel) × CHF/kW — méthode suisse correcte.
          </div>
        </div>
      </div>
    </div>
  );

  // ── ROI panel (shared, price curve editor) ────────────────────────────────
  const RoiPanel = () => {
    const isPS  = analysisMode === 'peakshaving';
    const curve = isPS ? psCurve : acCurve;
    if (!curve) return null;

    const maxBatt = isPS
      ? (psCurve.points[psCurve.points.length-1]?.batterySizeKWh ?? 200)
      : ((acOptimal?.capKWh ?? 200) * 2);
    const priceCurveMax = Math.min(2000, Math.ceil(maxBatt * 1.2 / 100) * 100);
    const priceCurveDisplay = buildPriceCurveDisplay(priceAnchors, priceCurveMax);

    // ROI KPI
    const currentSavings = isPS ? psScenario?.annualSavings : acScenario?.annualSavings;
    const currentRoi     = isPS ? psScenario?.roi : acScenario?.roi;
    const currentPrix    = isPS ? psScenario?.prix : acScenario?.prix;
    const currentKwh     = isPS ? psScenario?.batterySizeKWh : acScenario?.capKWh;

    const roiPoints = isPS ? psRoiCurve : acCurve.points.map(p => {
      const prix = getPrice(p.capKWh);
      const roi  = computeRoiWithInflation(prix, p.annualSavings, inflation, escal1to5, escal6to10);
      return { rate: p.capKWh, roi, savings: p.annualSavings, kwh: p.capKWh, prix: Math.round(prix) };
    });

    const validRoi    = roiPoints.filter(d => d.roi !== null && d.roi < 30);
    const optROIPoint = validRoi.length ? validRoi.reduce((b, d) => (d.roi < b.roi ? d : b)) : null;

    return (
      <>
        {/* KPI */}
        <div className="res-grid" style={{ marginBottom:24 }}>
          <div className="rcard hl-green">
            <div className="rl">Économies nettes annuelles</div>
            <div className="rv">{fmt(currentSavings)} CHF</div>
            <div className="rs">
              {isPS ? `Puissance : ${fmt(psScenario?.savPui ?? psScenario?.savingsPuissance)} CHF · Énergie : ${fmt(psScenario?.savEn ?? psScenario?.savingsEnergy)} CHF`
                    : `Énergie : ${fmt(acScenario?.savEn)} CHF · Puissance : ${fmt(acScenario?.savPui)} CHF`}
            </div>
          </div>
          <div className={`rcard ${currentRoi ? (currentRoi < 10 ? 'hl-green' : 'hl-amber') : ''}`}>
            <div className="rl">TRI (avec inflation {inflation}%)</div>
            <div className="rv">{currentRoi != null ? `${currentRoi.toFixed(1)} ans` : currentPrix > 0 ? '> 40 ans' : '—'}</div>
            <div className="rs" style={{ marginTop:4 }}>
              ROI : <strong>{currentKwh > 0 && currentPrix > 0 && currentSavings > 0 ? `${computeRoiPct(currentPrix, currentSavings)}%` : '—'}</strong>
              <span style={{ color:'var(--muted)', fontWeight:400 }}> (économies / investissement)</span>
            </div>
            <div className="rs">Investissement : {fmt(currentPrix)} CHF · {currentKwh?.toFixed(0)} kWh</div>
            {currentRoi && (
              <div className="roi-track">
                <div className="roi-fill" style={{ width:`${Math.min(100,(currentRoi/15)*100)}%`, background:currentRoi<8?'var(--green)':'var(--amber)' }}/>
              </div>
            )}
          </div>
          <div className="rcard hl-blue">
            <div className="rl">{isPS ? 'Taux optimal (TRI min.)' : 'Capacité optimale (TRI min.)'}</div>
            <div className="rv">{optROIPoint ? (isPS ? `${optROIPoint.rate}%` : `${optROIPoint.kwh?.toFixed(0)} kWh`) : '—'}</div>
            <div className="rs">{optROIPoint ? `TRI ${optROIPoint.roi?.toFixed(1)} ans · ROI ${computeRoiPct(optROIPoint.prix, optROIPoint.savings) ?? '—'}% · ${fmt(optROIPoint.prix)} CHF` : '—'}</div>
          </div>
        </div>

        {/* Charts */}
        <div className="two-col" style={{ marginBottom:24 }}>
          <div className="sec">
            <div className="sec-title"><span className="dot"/>Économies nettes par {isPS ? 'taux' : 'taille de batterie'}</div>
            <div className="card">
              <ResponsiveContainer width="100%" height={230}>
                <AreaChart data={roiPoints} margin={{ top:10, right:20, left:10, bottom:20 }}>
                  <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3"/>
                  <XAxis dataKey={isPS ? 'rate' : 'kwh'} stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                    label={{ value: isPS ? 'Taux (%)' : 'Batterie (kWh)', position:'insideBottom', offset:-10, fill:'#7a90a8', fontSize:11 }}/>
                  <YAxis stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }} tickFormatter={v => `${Math.round(v/1000)}k`}/>
                  <Tooltip content={<ChartTip unit="CHF/an"/>}/>
                  <Area type="monotone" dataKey="savings" name="Économies nettes" stroke="#0d9f6e" strokeWidth={2} fill="#0d9f6e18" dot={false}/>
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="sec">
            <div className="sec-title"><span className="dot" style={{ background:'var(--amber)' }}/>TRI par {isPS ? 'taux' : 'taille de batterie'}</div>
            <div className="card">
              <ResponsiveContainer width="100%" height={230}>
                <LineChart data={validRoi} margin={{ top:10, right:20, left:10, bottom:20 }}>
                  <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3"/>
                  <XAxis dataKey={isPS ? 'rate' : 'kwh'} stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                    label={{ value: isPS ? 'Taux (%)' : 'Batterie (kWh)', position:'insideBottom', offset:-10, fill:'#7a90a8', fontSize:11 }}/>
                  <YAxis stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }} label={{ value:'TRI (ans)', angle:-90, position:'insideLeft', fill:'#7a90a8', fontSize:11 }}/>
                  <Tooltip content={<ChartTip unit="ans"/>}/>
                  <ReferenceLine y={10} stroke="#d97706" strokeDasharray="4 3" label={{ value:'TRI 10 ans', fill:'#d97706', fontSize:10, position:'insideTopRight' }}/>
                  <Line type="monotone" dataKey="roi" name="TRI (ans)" stroke="#d97706" strokeWidth={2.5} dot={false}/>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Price curve editor */}
        <div className="sec">
          <div className="sec-title"><span className="dot" style={{ background:'var(--blue)' }}/>Courbe de prix batterie — éditable</div>
          <div className="card">
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:24 }}>
              <div>
                <div className="cfg-label" style={{ marginBottom:10 }}>Points de contrôle</div>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <thead><tr style={{ borderBottom:'1px solid var(--border)' }}>
                    <th style={{ padding:'6px 10px', textAlign:'left', color:'var(--muted)', fontWeight:500, fontSize:11 }}>Capacité</th>
                    <th style={{ padding:'6px 10px', textAlign:'left', color:'var(--muted)', fontWeight:500, fontSize:11 }}>CHF/kWh</th>
                    <th style={{ padding:'6px 10px', textAlign:'left', color:'var(--muted)', fontWeight:500, fontSize:11 }}>Total</th>
                  </tr></thead>
                  <tbody>
                    {priceAnchors.map((a, idx) => (
                      <tr key={idx} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'5px 10px', color:'var(--text2)' }}>{a.kwh} kWh</td>
                        <td style={{ padding:'5px 10px' }}>
                          <div className="inp-row" style={{ maxWidth:110 }}>
                            <DeferredInput type="number" value={a.chfPerKwh} min={100} max={3000} step={10} style={{ textAlign:'right' }}
                              onChange={v => { const n=[...priceAnchors]; n[idx]={...n[idx],chfPerKwh:v}; setPriceAnchors(n); }}/>
                            <span className="inp-pfx" style={{ borderLeft:'1px solid var(--border)', borderRight:'none' }}>CHF</span>
                          </div>
                        </td>
                        <td style={{ padding:'5px 10px', color:'var(--green)', fontWeight:600 }}>{fmt(a.kwh*a.chfPerKwh)} CHF</td>
                      </tr>
                    ))}
                    {/* Custom offer row */}
                    <tr style={{ background:'var(--amber-l)', borderTop:'2px solid var(--amber)' }}>
                      <td style={{ padding:'8px 10px' }}>
                        <div className="inp-row" style={{ maxWidth:110 }}>
                          <DeferredInput type="number" value={customBattery.kwh} placeholder="kWh" min={1}
                            onChange={v => setCustomBattery(p => ({ ...p, kwh:v }))}/>
                          <span className="inp-pfx" style={{ borderLeft:'1px solid var(--border)', borderRight:'none' }}>kWh</span>
                        </div>
                      </td>
                      <td style={{ padding:'8px 10px', color:'var(--amber)', fontWeight:600, fontSize:11 }}>Offre spécifique</td>
                      <td style={{ padding:'8px 10px' }}>
                        <div className="inp-row" style={{ maxWidth:130 }}>
                          <span className="inp-pfx">CHF</span>
                          <DeferredInput type="number" value={customBattery.price} placeholder="total" min={1}
                            onChange={v => setCustomBattery(p => ({ ...p, price:v }))}/>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {customBattValid && (
                  <div style={{ marginTop:8, fontSize:11, color:'var(--amber)', background:'var(--amber-l)', border:'1px solid #fde68a', borderRadius:8, padding:'6px 12px' }}>
                    ★ Offre active : {customBattValid.kwh} kWh à {fmt(customBattValid.price)} CHF ({fmt(customBattValid.price/customBattValid.kwh)} CHF/kWh)
                  </div>
                )}
              </div>
              <div>
                <div className="cfg-label" style={{ marginBottom:10 }}>Courbe prix total (CHF)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={priceCurveDisplay} margin={{ top:5, right:10, left:10, bottom:20 }}>
                    <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3"/>
                    <XAxis dataKey="kwh" stroke="#c8d4e3" tickLine={false} tick={{ fontSize:10, fill:'#7a90a8' }}
                      label={{ value:'Capacité (kWh)', position:'insideBottom', offset:-10, fill:'#7a90a8', fontSize:10 }}/>
                    <YAxis stroke="#c8d4e3" tickLine={false} tick={{ fontSize:10, fill:'#7a90a8' }} tickFormatter={v => `${Math.round(v/1000)}k`}
                      label={{ value:'Prix (CHF)', angle:-90, position:'insideLeft', offset:14, fill:'#7a90a8', fontSize:10 }}/>
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return <div style={{ background:'#fff', border:'1px solid #dde4ed', borderRadius:8, padding:'8px 12px', fontSize:12 }}>
                        <div style={{ color:'#7a90a8', marginBottom:4 }}>{label} kWh</div>
                        <strong style={{ color:'#1a6fbf' }}>{fmt(payload[0].value)} CHF</strong>
                        <div style={{ color:'#7a90a8', fontSize:11, marginTop:2 }}>{label > 0 ? Math.round(payload[0].value/label) : 0} CHF/kWh</div>
                      </div>;
                    }}/>
                    <Area type="monotone" dataKey="totalPrice" name="Prix total" stroke="#1a6fbf" strokeWidth={2} fill="#1a6fbf15" dot={false}/>
                    {customBattValid && <ReferenceLine x={customBattValid.kwh} stroke="#d97706" strokeWidth={2} strokeDasharray="4 3"
                      label={{ value:`★ ${fmt(customBattValid.price)} CHF`, fill:'#d97706', fontSize:10, position:'top' }}/>}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════
  return (
    <>
      <style>{css}</style>
      {(loading || computing) && <div className="lbar"/>}
      <div className="app">

        {/* ── HEADER ── */}
        <header className="hdr">
          <div className="hdr-logo">⚡</div>
          <div>
            <div className="hdr-title">Dimensionnement BESS par CFR</div>
            <div className="hdr-sub">Analyse économique · Transition énergétique</div>
          </div>
          {fileName && <div className="hdr-badge">{fileName}</div>}
          {phase !== 'upload' && (
            <button className="btn-outline" style={{ marginLeft:12, fontSize:12, padding:'6px 14px' }} onClick={handleReset}>
              ↺ Nouveau fichier
            </button>
          )}
        </header>

        {/* ── NAV (only in dashboard) ── */}
        {phase === 'dashboard' && (
          <nav className="nav">
            {currentTabs.map(t => (
              <button key={t.id} className={`nav-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </nav>
        )}

        <div className="main">

          {/* ── UPLOAD ── */}
          {phase === 'upload' && (
            <div className="upload-wrap">
              <div className={`upload-zone ${drag ? 'drag' : ''}`}
                onDragOver={e => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={e => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files[0]); }}>
                <label style={{ display:'block', cursor:'pointer' }}>
                  <input ref={fileRef} type="file" accept=".csv" style={{ display:'none' }}
                    onChange={e => { handleFile(e.target.files[0]); e.target.value=''; }}/>
                  <div className="uz-icon">📂</div>
                  <div className="uz-title">Importer les données client</div>
                  <div className="uz-sub">Glissez-déposez ou cliquez pour sélectionner un fichier CSV</div>
                  <div className="uz-hint">
                    Colonnes : <strong>timestamp</strong> · <strong>production_pv</strong> · <strong>consommation</strong><br/>
                    kWh par tranche de 15 min · ≥ 1 an recommandé
                  </div>
                </label>
              </div>
              <div className="upload-or">— ou —</div>
              <div style={{ textAlign:'center' }}>
                <button className="btn-outline" onClick={handleDemo}>▶ Charger des données de démonstration</button>
              </div>
            </div>
          )}

          {/* ── PROFILE SELECTION ── */}
          {phase === 'profile' && profile && (
            <div className="profile-select">
              <div style={{ textAlign:'center', marginBottom:32 }}>
                <div style={{ fontFamily:'var(--font-h)', fontSize:22, fontWeight:800, marginBottom:8 }}>Choisissez votre stratégie</div>
                <div style={{ fontSize:14, color:'var(--muted)' }}>
                  Analyse du profil : <strong style={{ color:'var(--text)' }}>{profile.reason}</strong>
                </div>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                <div className={`profile-card ${profile.mode === 'peakshaving' ? 'selected' : ''}`}
                  onClick={() => handleModeSelect('peakshaving')}>
                  <div className="profile-icon">🏭</div>
                  <div className="profile-title">Peak Shaving</div>
                  <div className="profile-desc">
                    Réduire la puissance crête souscrite au réseau. Idéal si votre client paie un tarif de puissance élevé ou a des pics de demande marqués.
                    <br/><br/>
                    <strong>EMS prédictif :</strong> charge préventive nocturne, anticipation des pics.
                  </div>
                  {profile.mode === 'peakshaving' && <div className="profile-badge suggested">★ Recommandé pour ce profil</div>}
                  {profile.mode !== 'peakshaving' && <div className="profile-badge alt">Option alternative</div>}
                </div>
                <div className={`profile-card ${profile.mode === 'autoconso' ? 'selected' : ''}`}
                  onClick={() => handleModeSelect('autoconso')}>
                  <div className="profile-icon">☀️</div>
                  <div className="profile-title">Autoconsommation</div>
                  <div className="profile-desc">
                    Maximiser l'utilisation de la production PV sur site. Idéal si votre client a une grande installation PV et veut réduire ses achats réseau.
                    <br/><br/>
                    <strong>EMS passif :</strong> charge depuis le surplus PV, décharge pour couvrir la demande.
                  </div>
                  {profile.mode === 'autoconso' && <div className="profile-badge suggested">★ Recommandé pour ce profil</div>}
                  {profile.mode !== 'autoconso' && <div className="profile-badge alt">Option alternative</div>}
                </div>
              </div>
              {profile.mode === 'mixed' && (
                <div className="info-box" style={{ marginTop:16 }}>
                  ℹ️ Ce profil est mixte — les deux stratégies sont pertinentes. Choisissez selon la priorité économique du client.
                </div>
              )}
            </div>
          )}

          {/* ── COMPUTING ── */}
          {phase === 'computing' && (
            <div className="computing">
              <div className="spin">⚙️</div>
              <h3>Calcul en cours…</h3>
              <p>Stratégie : <strong>{analysisMode === 'peakshaving' ? 'Peak Shaving' : 'Autoconsommation'}</strong> · {data?.length?.toLocaleString()} intervalles</p>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              DASHBOARD — PEAK SHAVING
          ══════════════════════════════════════════════════════════════ */}
          {phase === 'dashboard' && analysisMode === 'peakshaving' && psCurve && (() => {
            const { points, baseMaxKW } = psCurve;
            const maxRate = points[points.length - 1]?.rate ?? 0;

            // ── Overview tab ──
            if (tab === 'overview') return (
              <>
                {/* Top KPIs */}
                <div className="stats">
                  <div className="scard green">
                    <div className="lbl">Batterie optimale (TRI min.)</div>
                    <div className="val">{psOptimal?.batterySizeKWh?.toFixed(0) ?? '—'}<span className="unit">kWh</span></div>
                    <div className="sub">taux {psOptimal?.rate}% · TRI {psOptimal?.roi?.toFixed(1)} ans · ROI {psOptimal ? computeRoiPct(psOptimal.prix, psOptimal.annualSavings) : '—'}%</div>
                  </div>
                  <div className="scard blue">
                    <div className="lbl">Économies annuelles optimales</div>
                    <div className="val">{fmt(psOptimal?.annualSavings)}<span className="unit">CHF</span></div>
                    <div className="sub">puissance + énergie</div>
                  </div>
                  <div className={`scard ${psOptimal?.roi && psOptimal.roi < 10 ? 'green' : 'amber'}`}>
                    <div className="lbl">TRI optimal</div>
                    <div className="val">{psOptimal?.roi?.toFixed(1) ?? '—'}<span className="unit">ans</span></div>
                    <div className="sub">{fmt(psOptimal ? getPrice(psOptimal.batterySizeKWh) : 0)} CHF investissement</div>
                  </div>
                  <div className="scard teal">
                    <div className="lbl">Puissance crête réseau</div>
                    <div className="val">{baseMaxKW.toFixed(1)}<span className="unit">kW</span></div>
                    <div className="sub">sans batterie</div>
                  </div>
                </div>

                {/* Before/After */}
                {psOptimal && (() => {
                  const optSim = runSim(data, baseMaxKW * (1 - psOptimal.rate / 100), psOptimal.batterySizeKWh, 'peakshaving', hpHc);
                  return <BeforeAfter base={psCurve.base} sim={optSim} capKWh={psOptimal.batterySizeKWh}
                    prixPuissance={prixPuissance} hpHc={hpHc} prixAchat={prixAchat} label="optimal"/>;
                })()}

                {/* Mini ROI preview */}
                <div className="sec">
                  <div className="sec-title"><span className="dot" style={{ background:'var(--amber)' }}/>TRI par taux de peak shaving</div>
                  <div className="card">
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={psRoiCurve.filter(d => d.roi !== null && d.roi < 30)} margin={{ top:5, right:20, left:10, bottom:16 }}>
                        <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3"/>
                        <XAxis dataKey="rate" stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                          label={{ value:'Taux (%)', position:'insideBottom', offset:-8, fill:'#7a90a8', fontSize:11 }}/>
                        <YAxis stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                          label={{ value:'TRI (ans)', angle:-90, position:'insideLeft', fill:'#7a90a8', fontSize:11 }}/>
                        <Tooltip content={<ChartTip unit="ans"/>}/>
                        <ReferenceLine y={10} stroke="#d97706" strokeDasharray="4 3" label={{ value:'TRI 10 ans', fill:'#d97706', fontSize:10, position:'insideTopRight' }}/>
                        {psOptimal && <ReferenceLine x={psOptimal.rate} stroke="#0d9f6e" strokeDasharray="4 3"
                          label={{ value:`★ ${psOptimal.rate}%`, fill:'#0d9f6e', fontSize:10, position:'insideTopLeft' }}/>}
                        <Line type="monotone" dataKey="roi" name="TRI (ans)" stroke="#d97706" strokeWidth={2.5} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                    <div style={{ textAlign:'center', marginTop:8, fontSize:11, color:'var(--muted)' }}>
                      ★ = taux optimal ({psOptimal?.rate}%, TRI {psOptimal?.roi?.toFixed(1)} ans · ROI {psOptimal ? computeRoiPct(psOptimal.prix, psOptimal.annualSavings) : '—'}%) · Explorez ⚡ Dimensionnement pour ajuster
                    </div>
                  </div>
                </div>
              </>
            );

            // ── Sizing tab ──
            if (tab === 'sizing') return (
              <>
                <div className="stats">
                  <div className="scard green">
                    <div className="lbl">Batterie · scénario</div>
                    <div className="val">{psScenario?.batterySizeKWh?.toFixed(0) ?? '—'}<span className="unit">kWh</span></div>
                    <div className="sub">pour {selectedRate}% de peak shaving</div>
                  </div>
                  <div className="scard blue">
                    <div className="lbl">Puissance crête réseau</div>
                    <div className="val">{baseMaxKW.toFixed(1)}<span className="unit">kW</span></div>
                    <div className="sub">sans batterie</div>
                  </div>
                  <div className="scard teal">
                    <div className="lbl">Seuil après peak shaving</div>
                    <div className="val">{psScenario?.threshold?.toFixed(1) ?? '—'}<span className="unit">kW</span></div>
                    <div className="sub">réduction de {selectedRate}%</div>
                  </div>
                  <div className="scard amber">
                    <div className="lbl">Peak shaving max physique</div>
                    <div className="val">{maxRate}<span className="unit">%</span></div>
                    <div className="sub">limite sur les données</div>
                  </div>
                </div>

                {/* Sizing curve */}
                <div className="sec">
                  <div className="sec-title"><span className="dot"/>Courbe de dimensionnement</div>
                  <div className="card">
                    <ResponsiveContainer width="100%" height={270}>
                      <AreaChart data={points} margin={{ top:10, right:20, left:10, bottom:24 }}>
                        <defs><linearGradient id="ggrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#0d9f6e" stopOpacity={0.15}/>
                          <stop offset="95%" stopColor="#0d9f6e" stopOpacity={0}/>
                        </linearGradient></defs>
                        <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3"/>
                        <XAxis dataKey="rate" stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                          label={{ value:'Taux de peak shaving (%)', position:'insideBottom', offset:-12, fill:'#7a90a8', fontSize:11 }}/>
                        <YAxis stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                          label={{ value:'Batterie min. (kWh)', angle:-90, position:'insideLeft', offset:12, fill:'#7a90a8', fontSize:11 }}/>
                        <Tooltip content={<ChartTip unit="kWh"/>}/>
                        {psOptimal && <ReferenceLine x={psOptimal.rate} stroke="#1a6fbf" strokeDasharray="4 3" strokeWidth={1.5}
                          label={{ value:`★ ${psOptimal.rate}%`, fill:'#1a6fbf', fontSize:10, position:'insideTopLeft' }}/>}
                        <ReferenceLine x={sliderRate} stroke="#0d9f6e" strokeDasharray="4 3" strokeWidth={1.5}/>
                        <Area type="monotone" dataKey="batterySizeKWh" name="Batterie min." stroke="#0d9f6e" strokeWidth={2.5} fill="url(#ggrad)" dot={false}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Config */}
                <div className="cfg-panel">
                  <div style={{ fontFamily:'var(--font-h)', fontWeight:700, fontSize:14, marginBottom:18 }}>Scénario sélectionné</div>
                  <div className="cfg-grid">
                    <div>
                      <div className="cfg-label">Taux de peak shaving cible</div>
                      <div className="slider-row">
                        <input type="range" min={0} max={maxRate}
                          value={sliderRate}
                          onChange={e => setSliderRate(Number(e.target.value))}
                          onMouseUp={e => setSelectedRate(Number(e.target.value))}
                          onTouchEnd={e => setSelectedRate(Number(e.target.value))}
                        />
                        <div className="slider-val">{sliderRate}%</div>
                      </div>
                      <div className="slider-sub">
                        {sliderRate !== selectedRate
                          ? <span style={{ color:'var(--muted)' }}>Relâchez pour calculer ce scénario…</span>
                          : <>
                            Seuil : <strong style={{ color:'var(--text)' }}>{psScenario?.threshold?.toFixed(1)} kW</strong>
                            &nbsp;·&nbsp; Batterie : <strong style={{ color:'var(--green)' }}>{psScenario?.batterySizeKWh?.toFixed(0)} kWh</strong>
                            &nbsp;·&nbsp; Prix : <strong style={{ color:'var(--amber)' }}>{fmt(psScenario?.prix)} CHF</strong>
                          </>
                        }
                      </div>
                      {psOptimal && (
                        <button className="btn-outline" style={{ marginTop:10, fontSize:11, padding:'5px 14px' }}
                          onClick={() => { setSliderRate(psOptimal.rate); setSelectedRate(psOptimal.rate); }}>
                          ★ Taux optimal ({psOptimal.rate}%)
                        </button>
                      )}
                    </div>
                    <div className="inp-group">
                      <div className="cfg-label">Tarif puissance réseau</div>
                      <div className="inp-row">
                        <span className="inp-pfx">CHF</span>
                        <DeferredInput type="number" value={prixPuissance} min={0} step={0.5}
                          onChange={v => { setPrixPuissance(v); handleTariffChange(prixAchat, prixVente, v, hpHc); }}/>
                        <span className="inp-pfx" style={{ borderLeft:'1px solid var(--border)', borderRight:'none' }}>/kW/mois</span>
                      </div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', justifyContent:'center' }}>
                      <div style={{ fontSize:12, color:'var(--muted)', lineHeight:2.1 }}>
                        Peak avant : <strong style={{ color:'var(--text)' }}>{baseMaxKW.toFixed(1)} kW</strong><br/>
                        Peak après : <strong style={{ color:'var(--green)' }}>{psScenario?.maxGridKW?.toFixed(1)} kW</strong><br/>
                        Données : <strong style={{ color:'var(--text2)' }}>{Math.round(data.length / 96)} jours</strong>
                      </div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', justifyContent:'center' }}>
                      <div style={{ fontSize:12, color:'var(--muted)', lineHeight:2.1 }}>
                        TRI : <strong style={{ color: psScenario?.roi ? (psScenario.roi < 10 ? 'var(--green)' : 'var(--amber)') : 'var(--muted)' }}>
                          {psScenario?.roi ? `${psScenario.roi.toFixed(1)} ans` : psScenario?.prix > 0 ? '> 40 ans' : '—'}
                        </strong><br/>
                        ROI : <strong style={{ color:'var(--green)' }}>
                          {psScenario?.prix > 0 && psScenario?.annualSavings > 0 ? `${computeRoiPct(psScenario.prix, psScenario.annualSavings)}%` : '—'}
                        </strong><br/>
                        Écon./an : <strong style={{ color:'var(--green)' }}>{fmt(psScenario?.annualSavings)} CHF</strong>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Monthly peaks */}
                <div className="sec">
                  <div className="sec-title"><span className="dot" style={{ background:'var(--blue)' }}/>Puissances crêtes mensuelles — Avant / Après</div>
                  <div className="card">
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={monthlyData} margin={{ top:10, right:20, left:10, bottom:5 }}>
                        <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3" vertical={false}/>
                        <XAxis dataKey="month" stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}/>
                        <YAxis stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }} label={{ value:'kW', angle:-90, position:'insideLeft', fill:'#7a90a8', fontSize:11 }}/>
                        <Tooltip content={<ChartTip unit="kW"/>}/>
                        <Legend wrapperStyle={{ fontSize:11, paddingTop:10 }}/>
                        <Bar dataKey="avant" name="Sans batterie" fill="#cbd5e1" radius={[3,3,0,0]}/>
                        <Bar dataKey="apres" name="Avec batterie" fill="#0d9f6e" radius={[3,3,0,0]}/>
                        <ReferenceLine y={psScenario?.threshold} stroke="#d97706" strokeDasharray="5 3" strokeWidth={1.5}
                          label={{ value:`Seuil ${psScenario?.threshold?.toFixed(0)} kW`, position:'insideTopRight', fill:'#d97706', fontSize:10 }}/>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Table */}
                <div className="sec">
                  <div className="sec-title"><span className="dot" style={{ background:'var(--teal)' }}/>Tableau de dimensionnement</div>
                  <div className="tbl-wrap"><div className="tbl-scroll">
                    <table>
                      <thead><tr>
                        <th>Taux</th><th>Seuil (kW)</th><th>Batterie (kWh)</th>
                        <th>Puissance (kW)</th><th>Écon. puissance</th><th>Écon. énergie</th><th>Écon. nettes/an</th>
                      </tr></thead>
                      <tbody>
                        {points.filter((p, i) => i % 5 === 0 || p.rate === selectedRate || p.rate === psOptimal?.rate).map(p => (
                          <tr key={p.rate} className={p.rate === selectedRate ? 'sel' : p.rate === psOptimal?.rate ? 'opt' : ''}>
                            <td className={p.rate === selectedRate ? 'acc' : ''}>{p.rate === psOptimal?.rate ? '★ ' : ''}{p.rate === selectedRate ? '▶ ' : ''}{p.rate}%</td>
                            <td>{p.thresholdKW} kW</td>
                            <td className={p.rate === selectedRate ? 'acc' : ''}>{p.batterySizeKWh} kWh</td>
                            <td>{(p.batterySizeKWh * C_RATE).toFixed(1)} kW</td>
                            <td className="blu">{fmt(p.savPui ?? p.savingsPuissance)} CHF</td>
                            <td>{fmt(p.savEn ?? p.savingsEnergy)} CHF</td>
                            <td style={{ fontWeight:600 }}>{fmt(p.annualSavings)} CHF</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div></div>
                </div>
              </>
            );

            if (tab === 'roi')    return <RoiPanel/>;
            if (tab === 'params') return <ParamsPanel/>;
            return null;
          })()}

          {/* ══════════════════════════════════════════════════════════════
              DASHBOARD — AUTOCONSOMMATION
          ══════════════════════════════════════════════════════════════ */}
          {phase === 'dashboard' && analysisMode === 'autoconso' && acCurve && (() => {
            const { points: acPoints, base: acBase } = acCurve;
            const optimal = acOptimal;
            const baseNoSelfCons = (acBase.selfConsRate * 100).toFixed(1);
            const withSelfCons   = ((acScenario?.selfConsRate ?? 0) * 100).toFixed(1);
            const hasPV = acBase.pvKWh > 0;

            // ── Overview tab ──
            if (tab === 'overview') return (
              <>
                {!hasPV && (
                  <div className="warn-box">
                    ⚠️ Aucune production PV dans ce fichier. L'analyse d'autoconsommation n'est pas significative.
                    Considérez de passer en mode Peak Shaving.
                  </div>
                )}
                {acBase.selfConsRate > 0.88 && hasPV && (
                  <div className="info-box">
                    ℹ️ Taux d'autoconsommation sans batterie déjà élevé ({baseNoSelfCons}%) — la batterie améliorera peu ce taux.
                    Le levier principal pour ce profil est le peak shaving. Le calcul inclut néanmoins les économies de puissance accessoires.
                  </div>
                )}

                {/* Top KPIs */}
                <div className="stats">
                  <div className="scard green">
                    <div className="lbl">Batterie optimale</div>
                    <div className="val">{optimal.capKWh.toFixed(0)}<span className="unit">kWh</span></div>
                    <div className="sub">minimise le TRI</div>
                  </div>
                  <div className="scard blue">
                    <div className="lbl">Économies annuelles</div>
                    <div className="val">{fmt(optimal.annualSavings)}<span className="unit">CHF</span></div>
                    <div className="sub">énergie + puissance incidentale</div>
                  </div>
                  <div className={`scard ${acScenario?.roi && acScenario.roi < 10 ? 'green' : 'amber'}`}>
                    <div className="lbl">TRI optimal</div>
                    <div className="val">{acScenario?.roi != null ? `${acScenario.roi.toFixed(1)}` : '—'}<span className="unit">ans</span></div>
                    <div className="sub">{fmt(getPrice(optimal?.capKWh ?? 0))} CHF · ROI {optimal ? computeRoiPct(getPrice(optimal.capKWh), optimal.annualSavings) : '—'}%</div>
                  </div>
                  <div className="scard purple">
                    <div className="lbl">Autoconsommation avec batterie</div>
                    <div className="val">{withSelfCons}<span className="unit">%</span></div>
                    <div className="sub">+{((acScenario?.selfConsRate ?? 0) - acBase.selfConsRate > 0 ? ((acScenario?.selfConsRate ?? 0) - acBase.selfConsRate)*100 : 0).toFixed(1)} pp vs sans batterie</div>
                  </div>
                </div>

                {/* Before/After */}
                {acScenario && (
                  <BeforeAfter base={acBase} sim={acScenario} capKWh={optimal.capKWh}
                    prixPuissance={prixPuissance} hpHc={hpHc} prixAchat={prixAchat} label="optimal"/>
                )}

                {/* Mini savings curve preview */}
                <div className="sec">
                  <div className="sec-title"><span className="dot" style={{ background:'var(--blue)' }}/>Économies & autoconsommation selon la taille de batterie</div>
                  <div className="card">
                    <ResponsiveContainer width="100%" height={230}>
                      <ComposedChart data={acPoints} margin={{ top:10, right:30, left:10, bottom:20 }}>
                        <CartesianGrid stroke="#e8eef5" strokeDasharray="3 3"/>
                        <XAxis dataKey="capKWh" stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                          label={{ value:'Capacité batterie (kWh)', position:'insideBottom', offset:-10, fill:'#7a90a8', fontSize:11 }}/>
                        <YAxis yAxisId="left"  stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }} tickFormatter={v => `${Math.round(v/1000)}k`}/>
                        <YAxis yAxisId="right" orientation="right" stroke="#c8d4e3" tickLine={false} tick={{ fontSize:11, fill:'#7a90a8' }}
                          domain={[0, 100]} label={{ value:'%', angle:90, position:'insideRight', fill:'#7a90a8', fontSize:11 }}/>
                        <Tooltip content={({ active, payload, label }) => {
                          if (!active || !payload?.length) return null;
                          return <div style={{ background:'#fff', border:'1px solid #dde4ed', borderRadius:10, padding:'10px 14px', fontSize:12 }}>
                            <div style={{ color:'#7a90a8', marginBottom:6 }}>{label} kWh</div>
                            {payload.map((p, i) => (
                              <div key={i} style={{ display:'flex', gap:8, marginBottom:2 }}>
                                <span style={{ width:8, height:8, borderRadius:'50%', background:p.color, display:'inline-block', marginTop:3, flexShrink:0 }}/>
                                <span style={{ color:'#3d5166' }}>{p.name}:</span>
                                <strong>{p.value?.toFixed(1)} {p.name.includes('%') || p.name.includes('cons') ? '%' : 'CHF'}</strong>
                              </div>
                            ))}
                          </div>;
                        }}/>
                        <Legend wrapperStyle={{ fontSize:11, paddingTop:10 }}/>
                        <ReferenceLine x={optimal.capKWh} yAxisId="left" stroke="#0d9f6e" strokeDasharray="4 3" strokeWidth={1.5}
                          label={{ value:`★ ${optimal.capKWh} kWh`, fill:'#0d9f6e', fontSize:10, position:'top' }}/>
                        <Bar yAxisId="left" dataKey="annualSavings" name="Économies (CHF)" fill="#0d9f6e" opacity={0.7} radius={[3,3,0,0]}/>
                        <Line yAxisId="right" type="monotone" dataKey="selfConsRate" name="Autoconsommation (%)" stroke="#1a6fbf" strokeWidth={2} dot={false}/>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </>
            );

            // ── AC detail tab ──
            if (tab === 'ac-detail') return (
              <>
                <div className="stats-3">
                  <div className="scard green">
                    <div className="lbl">Taux autoconsommation avec batterie</div>
                    <div className="val">{withSelfCons}<span className="unit">%</span></div>
                    <div className="sub">sans batterie : {baseNoSelfCons}%</div>
                  </div>
                  <div className="scard blue">
                    <div className="lbl">Taux d'autarcie avec batterie</div>
                    <div className="val">{((acScenario?.autarkyRate ?? 0)*100).toFixed(1)}<span className="unit">%</span></div>
                    <div className="sub">conso couverte par PV</div>
                  </div>
                  <div className="scard teal">
                    <div className="lbl">Gain autoconsommation</div>
                    <div className="val">+{Math.max(0, ((acScenario?.selfConsRate ?? 0) - acBase.selfConsRate)*100).toFixed(1)}<span className="unit">pp</span></div>
                    <div className="sub">vs PV sans batterie</div>
                  </div>
                </div>

                {/* Slider to choose battery size */}
                <div className="cfg-panel">
                  <div style={{ fontFamily:'var(--font-h)', fontWeight:700, fontSize:14, marginBottom:16 }}>Ajuster la taille de batterie</div>
                  <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:24, alignItems:'start' }}>
                    <div>
                      <div className="cfg-label">Capacité de la batterie</div>
                      <div className="slider-row">
                        <input type="range" min={0} max={acPoints[acPoints.length-1]?.capKWh ?? 200}
                          step={(acPoints[acPoints.length-1]?.capKWh ?? 200) / 40}
                          value={selectedAcCap ?? optimal.capKWh}
                          onChange={e => setSelectedAcCap(Math.round(Number(e.target.value) / 5) * 5)}/>
                        <div className="slider-val">{(selectedAcCap ?? optimal.capKWh).toFixed(0)} kWh</div>
                      </div>
                      <div className="slider-sub">
                        Prix : <strong style={{ color:'var(--amber)' }}>{fmt(getPrice(selectedAcCap ?? optimal.capKWh))} CHF</strong>
                        &nbsp;·&nbsp; Autoconso : <strong style={{ color:'var(--green)' }}>{withSelfCons}%</strong>
                        &nbsp;·&nbsp; Économies : <strong style={{ color:'var(--green)' }}>{fmt(acScenario?.annualSavings)} CHF/an</strong>
                      </div>
                      <button className="btn-outline" style={{ marginTop:10, fontSize:11, padding:'5px 14px' }}
                        onClick={() => setSelectedAcCap(optimal.capKWh)}>
                        ★ Revenir à la capacité optimale ({optimal.capKWh} kWh)
                      </button>
                    </div>
                    <div style={{ fontSize:12, color:'var(--muted)', lineHeight:2 }}>
                      TRI : <strong style={{ color: acScenario?.roi ? (acScenario.roi < 10 ? 'var(--green)' : 'var(--amber)') : 'var(--muted)' }}>
                        {acScenario?.roi != null ? `${acScenario.roi.toFixed(1)} ans` : '—'}
                      </strong><br/>
                      ROI : <strong style={{ color:'var(--green)' }}>
                        {acScenario?.prix > 0 && acScenario?.annualSavings > 0 ? `${computeRoiPct(acScenario.prix, acScenario.annualSavings)}%` : '—'}
                      </strong><br/>
                      Autarcie : <strong style={{ color:'var(--blue)' }}>{((acScenario?.autarkyRate ?? 0)*100).toFixed(1)}%</strong><br/>
                      Injection : <strong style={{ color:'var(--text)' }}>{fmt(acScenario?.injKWh)} kWh</strong>
                    </div>
                  </div>
                </div>

                {/* Gauges */}
                <div className="two-col">
                  <div className="sec">
                    <div className="sec-title"><span className="dot"/>Avant / Après batterie</div>
                    <div className="card">
                      {[
                        { label:'Sans batterie', sc:acBase.selfConsRate, au:acBase.autarkyRate, color:'#cbd5e1', tc:'#7a90a8' },
                        { label:`Avec batterie (${(selectedAcCap ?? optimal.capKWh).toFixed(0)} kWh)`, sc:acScenario?.selfConsRate??0, au:acScenario?.autarkyRate??0, color:'#0d9f6e', tc:'#0d9f6e' },
                      ].map(col => (
                        <div key={col.label} style={{ marginBottom:20 }}>
                          <div style={{ fontFamily:'var(--font-h)', fontWeight:700, fontSize:13, color:col.tc, marginBottom:12 }}>{col.label}</div>
                          {[{ lbl:'Autoconsommation', val:col.sc, c:col.color }, { lbl:'Autarcie', val:col.au, c:'#1a6fbf' }].map(g => (
                            <div key={g.lbl} style={{ marginBottom:10 }}>
                              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, fontWeight:600, color:'var(--muted)', marginBottom:5 }}>
                                <span>{g.lbl}</span>
                                <span style={{ color:col.tc, fontSize:14, fontFamily:'var(--font-h)', fontWeight:700 }}>{(g.val*100).toFixed(1)}%</span>
                              </div>
                              <div style={{ height:10, background:'var(--bg2)', borderRadius:5, overflow:'hidden' }}>
                                <div style={{ width:`${Math.min(100,g.val*100)}%`, height:'100%', background:g.c, borderRadius:5, transition:'width .6s' }}/>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="sec">
                    <div className="sec-title"><span className="dot" style={{ background:'var(--blue)' }}/>Bilan énergétique annuel</div>
                    <div className="card">
                      {[
                        { label:'Production PV',   val:acScenario?.pvKWh,       color:'#f59e0b' },
                        { label:'Consommation',     val:acScenario?.consoKWh,    color:'#1a6fbf' },
                        { label:'Achat réseau',     val:acScenario?.gridKWh,     color:'#dc2626' },
                        { label:'Injection réseau', val:acScenario?.injKWh,      color:'#0d9f6e' },
                        { label:'PV autoconsommé',  val:acScenario?.selfConsKWh, color:'#0891b2' },
                      ].map(row => {
                        const max = Math.max(acScenario?.pvKWh||1, acScenario?.consoKWh||1);
                        return (
                          <div key={row.label} style={{ marginBottom:12 }}>
                            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4 }}>
                              <span style={{ color:'var(--text2)' }}>{row.label}</span>
                              <strong style={{ color:row.color }}>{fmt(row.val)} kWh</strong>
                            </div>
                            <div style={{ height:7, background:'var(--bg2)', borderRadius:4, overflow:'hidden' }}>
                              <div style={{ width:`${Math.min(100,(row.val||0)/max*100)}%`, height:'100%', background:row.color, borderRadius:4, opacity:.8 }}/>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </>
            );

            if (tab === 'roi')    return <RoiPanel/>;
            if (tab === 'params') return <ParamsPanel/>;
            return null;
          })()}

        </div>
      </div>
      <SpeedInsights />
    </>
  );
}
