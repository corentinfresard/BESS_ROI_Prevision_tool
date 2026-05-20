import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import Papa from 'papaparse';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  BarChart,
  Bar,
  Legend,
  LineChart,
  Line,
  ComposedChart,
} from 'recharts';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const ETA_CHARGE = 0.97;
const ETA_DISCHARGE = 0.97;
const C_RATE = 0.5;
const DT = 0.25; // 15-min = 0.25h

// ─── BATTERY PRICE CURVE ─────────────────────────────────────────────────────
const DEFAULT_PRICE_ANCHORS = [
  { kwh: 5, chfPerKwh: 1200 },
  { kwh: 20, chfPerKwh: 950 },
  { kwh: 50, chfPerKwh: 800 },
  { kwh: 100, chfPerKwh: 700 },
  { kwh: 200, chfPerKwh: 620 },
  { kwh: 500, chfPerKwh: 560 },
  { kwh: 1000, chfPerKwh: 520 },
];

function batteryPriceFromCurve(kwh, anchors, customBattery) {
  // If a custom battery is defined and the size is close, use it
  if (customBattery && customBattery.kwh > 0 && customBattery.price > 0) {
    if (Math.abs(kwh - customBattery.kwh) < 1) return customBattery.price;
  }
  if (kwh <= 0) return 0;
  const sorted = [...anchors].sort((a, b) => a.kwh - b.kwh);
  if (kwh <= sorted[0].kwh) return kwh * sorted[0].chfPerKwh;
  if (kwh >= sorted[sorted.length - 1].kwh)
    return kwh * sorted[sorted.length - 1].chfPerKwh;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (kwh >= sorted[i].kwh && kwh <= sorted[i + 1].kwh) {
      const t = (kwh - sorted[i].kwh) / (sorted[i + 1].kwh - sorted[i].kwh);
      return (
        kwh *
        (sorted[i].chfPerKwh +
          t * (sorted[i + 1].chfPerKwh - sorted[i].chfPerKwh))
      );
    }
  }
  return kwh * sorted[sorted.length - 1].chfPerKwh;
}

function buildPriceCurveDisplay(anchors, maxKwh = 500) {
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const kwh = Math.round((maxKwh / 80) * i);
    pts.push({
      kwh,
      totalPrice: Math.round(batteryPriceFromCurve(kwh, anchors, null)),
    });
  }
  return pts;
}

// ─── ROI WITH INFLATION ───────────────────────────────────────────────────────
// Compute NPV-based payback period accounting for:
//   - electricity price inflation (annual %)
//   - power tariff escalation (different rates for yr 1-5 and yr 6-10)
function computeRoiWithInflation(
  investissement,
  annualSavingsBase,
  inflation,
  escalation1to5,
  escalation6to10
) {
  if (investissement <= 0 || annualSavingsBase <= 0) return null;
  let cumulative = 0;
  for (let yr = 1; yr <= 40; yr++) {
    // Savings grow with inflation + power tariff escalation
    const infMult = Math.pow(1 + inflation / 100, yr - 1);
    const escMult =
      yr <= 5
        ? Math.pow(1 + escalation1to5 / 100, yr - 1)
        : Math.pow(1 + escalation1to5 / 100, 4) *
          Math.pow(1 + escalation6to10 / 100, yr - 5);
    const savings = annualSavingsBase * infMult * escMult;
    cumulative += savings;
    if (cumulative >= investissement) {
      // Linear interpolation for fractional year
      const prevCum = cumulative - savings;
      const frac = (investissement - prevCum) / savings;
      return +(yr - 1 + frac).toFixed(2);
    }
  }
  return null; // > 40 years
}

// ─── SIMULATION ENGINE ────────────────────────────────────────────────────────
// Convention: CSV values = kWh per 15-min interval. Power kW = kWh / DT.
//
// EMS STRATEGY (improved vs Optisizer-style):
//  Priority 1: Discharge to shave peaks above threshold
//  Priority 2: Charge from PV surplus
//  Priority 3: Proactive grid charge at night if SoC too low to cover next-day peaks
//              (more aggressive than pure reactive — avoids "empty battery at peak" problem)

function computeBaseMax(data) {
  let bm = 0;
  for (const r of data) {
    const kw = (r.conso - r.pv) / DT;
    if (kw > bm) bm = kw;
  }
  return bm;
}

function runSim(data, thresholdKW, capKWh) {
  if (capKWh < 0.01) {
    // No battery: fast path
    let maxGridKW = 0;
    const monthlyPeaks = new Array(12).fill(0);
    let annualGridKWh = 0,
      annualInjKWh = 0;
    let annualPvKWh = 0,
      annualConsoKWh = 0,
      annualSelfConsKWh = 0;
    for (const r of data) {
      const netKW = (r.conso - r.pv) / DT;
      const gridKW = Math.max(0, netKW);
      const injKW = Math.max(0, -netKW);
      annualPvKWh += r.pv;
      annualConsoKWh += r.conso;
      // Direct self-consumption: min(pv, conso)
      annualSelfConsKWh += Math.min(r.pv, r.conso);
      annualGridKWh += gridKW * DT;
      annualInjKWh += injKW * DT;
      if (gridKW > maxGridKW) maxGridKW = gridKW;
      if (gridKW > monthlyPeaks[r.month]) monthlyPeaks[r.month] = gridKW;
    }
    const selfConsRate = annualPvKWh > 0 ? annualSelfConsKWh / annualPvKWh : 0;
    const autarkyRate =
      annualConsoKWh > 0 ? annualSelfConsKWh / annualConsoKWh : 0;
    return {
      maxGridKW,
      monthlyPeaks,
      annualGridKWh,
      annualInjKWh,
      annualSelfConsKWh,
      annualPvKWh,
      annualConsoKWh,
      selfConsRate,
      autarkyRate,
    };
  }

  let soc = capKWh * 0.5;
  let maxGridKW = 0;
  const monthlyPeaks = new Array(12).fill(0);
  let annualGridKWh = 0,
    annualInjKWh = 0;
  let annualPvKWh = 0,
    annualConsoKWh = 0;
  let annualSelfConsDirect = 0; // PV consumed directly without battery
  let annualSelfConsBatt = 0; // PV consumed via battery (discharged later)

  // Pre-compute rolling look-ahead peak (passed in or computed once)
  const n = data.length;
  let lookAheadPeak = data._lookAheadPeak;
  if (!lookAheadPeak) {
    lookAheadPeak = new Float64Array(n);
    // Efficient O(n) sliding window maximum using deque
    const deq = []; // indices, decreasing net demand
    for (let i = n - 1; i >= 0; i--) {
      const kw = (data[i].conso - data[i].pv) / DT;
      // Remove indices outside window
      while (deq.length && deq[deq.length - 1] < i) deq.pop();
      while (deq.length && (data[deq[0]].conso - data[deq[0]].pv) / DT <= kw)
        deq.shift();
      deq.unshift(i);
      // Remove expired
      while (deq.length && deq[deq.length - 1] >= i + 16) deq.pop();
      lookAheadPeak[i] = (data[deq[0]].conso - data[deq[0]].pv) / DT;
    }
  }

  for (let i = 0; i < n; i++) {
    const r = data[i];
    const netKW = (r.conso - r.pv) / DT;
    let gridKW = 0;
    let battDischargeKW = 0;
    let battChargeKW = 0;

    annualPvKWh += r.pv;
    annualConsoKWh += r.conso;

    if (netKW > thresholdKW) {
      // ── Priority 1: discharge to shave peak ──
      const neededKW = netKW - thresholdKW;
      const maxDisKW = Math.min(soc / DT / ETA_DISCHARGE, capKWh * C_RATE);
      const actualDisKW = Math.min(neededKW, maxDisKW);
      soc -= actualDisKW * DT * ETA_DISCHARGE;
      battDischargeKW = actualDisKW;
      gridKW = netKW - actualDisKW;

      // Self-cons: PV direct + battery discharge covers conso
      // Direct: min(pv, conso) – but battery covers the rest
      annualSelfConsDirect += Math.min(r.pv, r.conso);
      // Battery discharge credited as self-cons only if originally charged from PV
      // Simplified: all battery energy is assumed PV-sourced (conservative)
      annualSelfConsBatt += actualDisKW * DT;
    } else if (netKW < 0) {
      // ── Priority 2: charge from PV surplus ──
      const surplusKW = -netKW;
      const maxChKW = Math.min(
        (capKWh - soc) / DT / ETA_CHARGE,
        capKWh * C_RATE
      );
      const actualChKW = Math.min(surplusKW, maxChKW);
      soc += actualChKW * DT * ETA_CHARGE;
      battChargeKW = actualChKW;
      const injKW = surplusKW - actualChKW;
      annualInjKWh += injKW * DT;
      gridKW = 0;
      annualSelfConsDirect += r.conso; // all conso is covered by PV
    } else {
      // ── Priority 3: proactive night charging ──
      // Charge from grid if:
      //   - Off-peak hours (night)
      //   - There's a significant upcoming peak in next 4h
      //   - SoC insufficient to cover the expected gap
      const isOffPeak = r.hour < 7 || r.hour >= 22;
      const upcomingPeakKW = lookAheadPeak[i];
      const gapKW = Math.max(0, upcomingPeakKW - thresholdKW);
      const neededSocKWh = (gapKW * DT) / ETA_DISCHARGE; // energy needed to cover gap
      const targetSoc = Math.min(capKWh, neededSocKWh * 1.2); // 20% safety margin

      if (isOffPeak && soc < targetSoc && gapKW > 0) {
        // Charge from grid up to target
        const wantKW = Math.min(
          (targetSoc - soc) / DT / ETA_CHARGE,
          capKWh * C_RATE
        );
        const actualChKW = Math.max(0, wantKW);
        soc += actualChKW * DT * ETA_CHARGE;
        battChargeKW = actualChKW;
        gridKW = Math.max(0, netKW) + actualChKW;
      } else {
        gridKW = Math.max(0, netKW);
      }
      annualSelfConsDirect += Math.min(r.pv, r.conso);
    }

    soc = Math.max(0, Math.min(capKWh, soc));
    gridKW = Math.max(0, gridKW);
    if (gridKW > maxGridKW) maxGridKW = gridKW;
    if (gridKW > monthlyPeaks[r.month]) monthlyPeaks[r.month] = gridKW;
    annualGridKWh += gridKW * DT;
  }

  // Total self-consumption = direct + via battery (capped at total PV)
  const annualSelfConsKWh = Math.min(
    annualPvKWh,
    annualSelfConsDirect + annualSelfConsBatt
  );
  const selfConsRate = annualPvKWh > 0 ? annualSelfConsKWh / annualPvKWh : 0;
  const autarkyRate =
    annualConsoKWh > 0 ? annualSelfConsKWh / annualConsoKWh : 0;

  return {
    maxGridKW,
    monthlyPeaks,
    annualGridKWh,
    annualInjKWh,
    annualSelfConsKWh,
    annualPvKWh,
    annualConsoKWh,
    selfConsRate,
    autarkyRate,
  };
}

function minBattery(data, thresholdKW, baseMaxKW) {
  const huge = runSim(data, thresholdKW, baseMaxKW * 24);
  if (huge.maxGridKW > thresholdKW * 1.005) return Infinity;
  let lo = 0,
    hi = baseMaxKW * 24;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const res = runSim(data, thresholdKW, mid);
    if (res.maxGridKW <= thresholdKW * 1.005) hi = mid;
    else lo = mid;
  }
  return hi;
}

function computeCurve(data, prixAchat, prixVente, prixPuissance) {
  const baseMaxKW = computeBaseMax(data);
  // Pre-compute look-ahead peak once and cache on data array
  if (!data._lookAheadPeak) {
    const n = data.length;
    const lap = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let max = 0;
      for (let j = i; j < Math.min(n, i + 16); j++) {
        const kw = (data[j].conso - data[j].pv) / DT;
        if (kw > max) max = kw;
      }
      lap[i] = max;
    }
    data._lookAheadPeak = lap;
  }
  const base = runSim(data, baseMaxKW * 100, 0);

  const baseMonthlyPeaks = new Array(12).fill(0);
  for (const r of data) {
    const kw = (r.conso - r.pv) / DT;
    if (kw > baseMonthlyPeaks[r.month]) baseMonthlyPeaks[r.month] = kw;
  }
  const basePuissanceCost = baseMonthlyPeaks.reduce(
    (s, p) => s + p * prixPuissance,
    0
  );

  const points = [];
  for (let pct = 0; pct <= 99; pct++) {
    const thresholdKW = baseMaxKW * (1 - pct / 100);
    const cap = minBattery(data, thresholdKW, baseMaxKW);
    if (!isFinite(cap)) break;

    const sim = runSim(data, thresholdKW, cap);
    const newPuissanceCost = sim.monthlyPeaks.reduce(
      (s, p) => s + p * prixPuissance,
      0
    );
    const savingsPuissance = basePuissanceCost - newPuissanceCost;
    const savingsEnergy = (base.annualGridKWh - sim.annualGridKWh) * prixAchat;
    const lossInjection = (base.annualInjKWh - sim.annualInjKWh) * prixVente;
    const annualSavings = savingsPuissance + savingsEnergy - lossInjection;

    points.push({
      rate: pct,
      batterySizeKWh: Math.round(cap * 10) / 10,
      thresholdKW: Math.round(thresholdKW * 10) / 10,
      savingsPuissance: Math.round(savingsPuissance),
      savingsEnergy: Math.round(savingsEnergy),
      lossInjection: Math.round(lossInjection),
      annualSavings: Math.round(annualSavings),
      selfConsRate: Math.round(sim.selfConsRate * 1000) / 10,
      autarkyRate: Math.round(sim.autarkyRate * 1000) / 10,
      annualGridKWh: Math.round(sim.annualGridKWh),
      annualInjKWh: Math.round(sim.annualInjKWh),
    });
  }

  return { points, baseMaxKW, base, baseMonthlyPeaks, basePuissanceCost };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const result = Papa.parse(text.trim(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });
  const rows = [];
  for (const r of result.data) {
    const keys = Object.keys(r);
    let ts = null,
      pv = null,
      conso = null;
    for (const k of keys) {
      const kl = k.toLowerCase();
      if (
        ts === null &&
        (kl.includes('time') || kl.includes('date') || kl === 'timestamp')
      )
        ts = r[k];
      if (
        pv === null &&
        (kl.includes('pv') || kl.includes('prod') || kl.includes('solar')) &&
        typeof r[k] === 'number'
      )
        pv = r[k];
      if (
        conso === null &&
        (kl.includes('conso') ||
          kl.includes('load') ||
          kl.includes('demand') ||
          kl.includes('consumption')) &&
        typeof r[k] === 'number'
      )
        conso = r[k];
    }
    if (pv === null || conso === null) {
      const num = keys.filter((k) => typeof r[k] === 'number');
      if (num.length >= 2) {
        pv = r[num[0]];
        conso = r[num[1]];
      }
    }
    if (pv === null || conso === null) continue;
    let month = 0,
      hour = 0;
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d)) {
        month = d.getMonth();
        hour = d.getHours();
      }
    }
    rows.push({ pv: Math.max(0, pv), conso: Math.max(0, conso), month, hour });
  }
  return rows;
}

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
function generateDemoData() {
  const rows = [],
    start = new Date('2025-01-01T00:00:00');
  for (let i = 0; i < 365 * 96; i++) {
    const d = new Date(start.getTime() + i * 15 * 60000);
    const month = d.getMonth(),
      hour = d.getHours() + d.getMinutes() / 60;
    const solarHours = 4 + 3 * Math.sin((Math.PI * month) / 11);
    let pvKW = 0;
    if (Math.abs(hour - 12.5) < solarHours) {
      const x = (hour - 12.5) / solarHours;
      pvKW = Math.max(
        0,
        (8 + 5 * Math.sin((Math.PI * month) / 11)) * (1 - x * x) +
          (Math.random() - 0.5) * 0.5
      );
    }
    const base = 3 + Math.sin((Math.PI * month) / 5) * 0.5;
    const morningP =
      hour >= 7 && hour <= 9
        ? 2.5 * Math.exp(-0.5 * ((hour - 8) / 0.7) ** 2)
        : 0;
    const eveningP =
      hour >= 17 && hour <= 20
        ? 3 * Math.exp(-0.5 * ((hour - 18.5) / 0.8) ** 2)
        : 0;
    const isWD = d.getDay() >= 1 && d.getDay() <= 5;
    const spike =
      isWD && hour >= 8 && hour <= 18
        ? 10 *
          Math.exp(-0.5 * ((hour - 13) / 2) ** 2) *
          (Math.floor(i / 96) % 3 === 0 ? 1 : 0.25)
        : 0;
    const consoKW = Math.max(
      0,
      base + morningP + eveningP + spike + (Math.random() - 0.5) * 0.5
    );
    rows.push({
      pv: pvKW * DT,
      conso: consoKW * DT,
      month,
      hour: d.getHours(),
    });
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
  .lbar{position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#0d9f6e,#1a6fbf,#0891b2);animation:lbar 1.5s ease-in-out infinite;z-index:99;}
  @keyframes lbar{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px;}
  .scard{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;box-shadow:var(--shadow-s);}
  .scard.green{border-left:3px solid var(--green);} .scard.blue{border-left:3px solid var(--blue);}
  .scard.teal{border-left:3px solid var(--teal);} .scard.amber{border-left:3px solid var(--amber);}
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
  .rcard .rl{font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px;}
  .rcard .rv{font-family:var(--font-h);font-size:28px;font-weight:800;}
  .rcard.hl-green .rv{color:var(--green);} .rcard.hl-blue .rv{color:var(--blue);} .rcard.hl-amber .rv{color:var(--amber);}
  .rcard .rs{font-size:11px;color:var(--muted);margin-top:5px;line-height:1.6;}
  .roi-track{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;margin-top:10px;}
  .roi-fill{height:100%;border-radius:3px;transition:width .5s;}
  .tbl-wrap{overflow:hidden;border-radius:var(--r);border:1px solid var(--border);box-shadow:var(--shadow-s);}
  .tbl-scroll{overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  thead tr{background:var(--surface2);border-bottom:1px solid var(--border2);}
  th{padding:11px 16px;text-align:left;color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;}
  tbody tr{border-bottom:1px solid var(--border);transition:background .1s;}
  tbody tr:hover{background:var(--surface2);}
  tbody tr.sel{background:var(--green-l) !important;}
  td{padding:9px 16px;color:var(--text2);}
  td.acc{color:var(--green);font-weight:600;} td.blu{color:var(--blue);font-weight:600;} td.amb{color:var(--amber);font-weight:700;} td.red{color:var(--red);font-weight:700;} td.grn{color:var(--green);font-weight:700;}
  .computing{text-align:center;padding:80px 20px;}
  .computing .spin{font-size:36px;margin-bottom:16px;animation:spin 2s linear infinite;display:inline-block;}
  @keyframes spin{to{transform:rotate(360deg)}}
  .computing h3{font-family:var(--font-h);font-size:18px;font-weight:700;margin-bottom:6px;}
  .computing p{font-size:13px;color:var(--muted);}
  .info-box{background:var(--blue-l);border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;font-size:12px;color:var(--blue);line-height:1.7;margin-bottom:16px;}
  @media(max-width:960px){.main,.hdr,.nav{padding-left:16px;padding-right:16px;}.stats{grid-template-columns:1fr 1fr;}.cfg-grid,.res-grid,.two-col{grid-template-columns:1fr;}}
`;

// ─── TOOLTIP ─────────────────────────────────────────────────────────────────
const ChartTip = ({ active, payload, label, unit = '' }) => {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #dde4ed',
        borderRadius: 10,
        padding: '10px 14px',
        boxShadow: '0 4px 12px rgba(26,37,53,.12)',
        fontSize: 12,
      }}
    >
      <div style={{ color: '#7a90a8', marginBottom: 6, fontWeight: 500 }}>
        {label}
      </div>
      {payload.map((p, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            color: '#1a2535',
            marginBottom: 2,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: p.color,
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span style={{ color: '#3d5166' }}>{p.name}:</span>
          <strong>
            {typeof p.value === 'number' ? p.value.toFixed(1) : p.value} {unit}
          </strong>
        </div>
      ))}
    </div>
  );
};

const fmt = (n) => (n != null ? Math.round(n).toLocaleString('fr-CH') : '—');

// ─── DEFERRED INPUT — avoids recompute on every keystroke ─────────────────────
function DeferredInput({ value, onChange, ...props }) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  const commit = () => {
    const n = parseFloat(local);
    if (!isNaN(n) && n !== value) onChange(n);
    else setLocal(String(value));
  };
  return (
    <input
      {...props}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          e.target.blur();
        }
      }}
    />
  );
}

// ─── APP ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [curve, setCurve] = useState(null);
  const [drag, setDrag] = useState(false);
  const [tab, setTab] = useState('sizing');

  // Tariff params
  const [prixPuissance, setPrixPuissance] = useState(12);
  const [prixAchat, setPrixAchat] = useState(0.22);
  const [prixVente, setPrixVente] = useState(0.08);

  // Financial params
  const [inflation, setInflation] = useState(2.0); // % annual
  const [escal1to5, setEscal1to5] = useState(3.0); // % annual power tariff increase yr1-5
  const [escal6to10, setEscal6to10] = useState(2.0); // % annual power tariff increase yr6-10

  // Battery price
  const [priceAnchors, setPriceAnchors] = useState(DEFAULT_PRICE_ANCHORS);
  const [customBattery, setCustomBattery] = useState({ kwh: '', price: '' });

  // Scenario
  const [selectedRate, setSelectedRate] = useState(30);

  const fileRef = useRef();
  const dataRef = useRef(null); // stable ref to avoid stale closure in handleFile

  const runCurve = useCallback(async (rows, pa, pv, pp) => {
    setComputing(true);
    // Yield to UI before heavy computation
    await new Promise((r) => setTimeout(r, 50));
    // Run computation in a microtask so React can flush state updates first
    const result = await new Promise((resolve) => {
      setTimeout(() => resolve(computeCurve(rows, pa, pv, pp)), 0);
    });
    setCurve(result);
    setSelectedRate((prev) =>
      Math.min(prev, result.points[result.points.length - 1]?.rate ?? prev)
    );
    setComputing(false);
  }, []);

  const handleTariffCommit = useCallback(
    (pa, pv, pp) => {
      if (!dataRef.current) return;
      runCurve(dataRef.current, pa, pv, pp);
    },
    [runCurve]
  );

  // FIX: upload bug — use only the input onChange, stop propagation on div click
  const handleFile = useCallback(
    (file) => {
      if (!file) return;
      setFileName(file.name);
      setLoading(true);
      const reader = new FileReader();
      reader.onload = async (e) => {
        const rows = parseCSV(e.target.result);
        if (rows.length < 100) {
          alert('Fichier trop court ou colonnes non reconnues.');
          setLoading(false);
          return;
        }
        setData(rows);
        dataRef.current = rows;
        setLoading(false);
        await runCurve(rows, prixAchat, prixVente, prixPuissance);
      };
      reader.readAsText(file);
    },
    [runCurve, prixAchat, prixVente, prixPuissance]
  );

  const handleDemo = useCallback(async () => {
    setFileName('demo_données.csv');
    setLoading(true);
    await new Promise((r) => setTimeout(r, 30));
    const rows = generateDemoData();
    setData(rows);
    dataRef.current = rows;
    setLoading(false);
    await runCurve(rows, prixAchat, prixVente, prixPuissance);
  }, [runCurve, prixAchat, prixVente, prixPuissance]);

  const handleReset = useCallback(() => {
    setData(null);
    setCurve(null);
    setFileName(null);
    setLoading(false);
    setComputing(false);
    dataRef.current = null;
  }, []);

  // Effective custom battery (validated)
  const customBattValid = useMemo(() => {
    const k = parseFloat(customBattery.kwh);
    const p = parseFloat(customBattery.price);
    return k > 0 && p > 0 ? { kwh: k, price: p } : null;
  }, [customBattery]);

  const getPriceForSize = useCallback(
    (kwh) => {
      if (customBattValid && Math.abs(kwh - customBattValid.kwh) < 1)
        return customBattValid.price;
      return batteryPriceFromCurve(kwh, priceAnchors, null);
    },
    [priceAnchors, customBattValid]
  );

  // Selected scenario
  const scenario = useMemo(() => {
    if (!data || !curve) return null;
    const { points, baseMaxKW, base, baseMonthlyPeaks } = curve;
    const pt =
      points.find((p) => p.rate === selectedRate) ?? points[points.length - 1];
    if (!pt) return null;
    const thresholdKW = baseMaxKW * (1 - selectedRate / 100);
    const sim = runSim(data, thresholdKW, pt.batterySizeKWh);
    const prix = getPriceForSize(pt.batterySizeKWh);
    const roi = computeRoiWithInflation(
      prix,
      pt.annualSavings,
      inflation,
      escal1to5,
      escal6to10
    );
    return {
      ...pt,
      ...sim,
      thresholdKW,
      baseMaxKW,
      base,
      baseMonthlyPeaks,
      roi,
      prix,
    };
  }, [
    data,
    curve,
    selectedRate,
    getPriceForSize,
    inflation,
    escal1to5,
    escal6to10,
  ]);

  const roiCurveData = useMemo(() => {
    if (!curve) return [];
    return curve.points.map((p) => {
      const prix = getPriceForSize(p.batterySizeKWh);
      const roi = computeRoiWithInflation(
        prix,
        p.annualSavings,
        inflation,
        escal1to5,
        escal6to10
      );
      return {
        rate: p.rate,
        roi,
        savings: p.annualSavings,
        selfCons: p.selfConsRate,
        autarky: p.autarkyRate,
        batterySizeKWh: p.batterySizeKWh,
        batteryPrice: Math.round(prix),
      };
    });
  }, [curve, getPriceForSize, inflation, escal1to5, escal6to10]);

  const MONTHS = [
    'Jan',
    'Fév',
    'Mar',
    'Avr',
    'Mai',
    'Jun',
    'Jul',
    'Aoû',
    'Sep',
    'Oct',
    'Nov',
    'Déc',
  ];

  const monthlyData = useMemo(() => {
    if (!scenario) return [];
    return MONTHS.map((m, i) => ({
      month: m,
      avant: +scenario.baseMonthlyPeaks[i].toFixed(1),
      apres: +scenario.monthlyPeaks[i].toFixed(1),
    }));
  }, [scenario]);

  const curveData = useMemo(() => curve?.points ?? [], [curve]);

  const tabs = [
    { id: 'sizing', label: '⚡ Dimensionnement' },
    { id: 'roi', label: '📈 ROI & Économies' },
    { id: 'autoconso', label: '☀️ Autoconsommation' },
    { id: 'params', label: '⚙️ Paramètres' },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{css}</style>
      {(loading || computing) && <div className="lbar" />}
      <div className="app">
        <header className="hdr">
          <div className="hdr-logo">⚡</div>
          <div>
            <div className="hdr-title">Battery Sizing & Peak Shaving</div>
            <div className="hdr-sub">
              Analyse économique · Transition énergétique
            </div>
          </div>
          {fileName && <div className="hdr-badge">{fileName}</div>}
          {data && (
            <button
              className="btn-outline"
              style={{ marginLeft: 12, fontSize: 12, padding: '6px 14px' }}
              onClick={handleReset}
            >
              ↺ Nouveau fichier
            </button>
          )}
        </header>

        {data && curve && !computing && (
          <nav className="nav">
            {tabs.map((t) => (
              <button
                key={t.id}
                className={`nav-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        )}

        <div className="main">
          {/* ── Upload ── */}
          {!data && !computing && (
            <div className="upload-wrap">
              {/* FIX: div is purely visual, input handles the click directly */}
              <div
                className={`upload-zone ${drag ? 'drag' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  handleFile(e.dataTransfer.files[0]);
                }}
              >
                <label style={{ display: 'block', cursor: 'pointer' }}>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      handleFile(e.target.files[0]);
                      e.target.value = '';
                    }}
                  />
                  <div className="uz-icon">📂</div>
                  <div className="uz-title">Importer les données client</div>
                  <div className="uz-sub">
                    Glissez-déposez ou cliquez pour sélectionner un fichier CSV
                  </div>
                  <div className="uz-hint">
                    Colonnes requises : <strong>timestamp</strong> ·{' '}
                    <strong>production_pv</strong> ·{' '}
                    <strong>consommation</strong>
                    <br />
                    Unité : kWh par tranche de 15 min · Période : ≥ 1 an
                    recommandé
                  </div>
                </label>
              </div>
              <div className="upload-or">— ou —</div>
              <div style={{ textAlign: 'center' }}>
                <button className="btn-outline" onClick={handleDemo}>
                  ▶ Charger des données de démonstration
                </button>
              </div>
            </div>
          )}

          {/* ── Computing ── */}
          {computing && (
            <div className="computing">
              <div className="spin">⚙️</div>
              <h3>Calcul en cours…</h3>
              <p>
                Simulation sur {data?.length?.toLocaleString()} intervalles ·
                Recherche dichotomique taux 0 → max
              </p>
            </div>
          )}

          {/* ── Dashboard ── */}
          {data &&
            curve &&
            !computing &&
            (() => {
              const { points, baseMaxKW } = curve;
              const maxRate = points[points.length - 1]?.rate ?? 0;

              return (
                <>
                  {/* ══ SIZING ══ */}
                  {tab === 'sizing' && (
                    <>
                      <div className="stats">
                        <div className="scard green">
                          <div className="lbl">Batterie · scénario</div>
                          <div className="val">
                            {scenario?.batterySizeKWh?.toFixed(0) ?? '—'}
                            <span className="unit">kWh</span>
                          </div>
                          <div className="sub">
                            pour {selectedRate}% de peak shaving
                          </div>
                        </div>
                        <div className="scard blue">
                          <div className="lbl">Puissance crête réseau</div>
                          <div className="val">
                            {baseMaxKW.toFixed(1)}
                            <span className="unit">kW</span>
                          </div>
                          <div className="sub">sans batterie</div>
                        </div>
                        <div className="scard teal">
                          <div className="lbl">Seuil après peak shaving</div>
                          <div className="val">
                            {scenario?.thresholdKW?.toFixed(1) ?? '—'}
                            <span className="unit">kW</span>
                          </div>
                          <div className="sub">
                            réduction de {selectedRate}%
                          </div>
                        </div>
                        <div className="scard amber">
                          <div className="lbl">Peak shaving max physique</div>
                          <div className="val">
                            {maxRate}
                            <span className="unit">%</span>
                          </div>
                          <div className="sub">
                            limite calculée sur les données
                          </div>
                        </div>
                      </div>

                      <div className="sec">
                        <div className="sec-title">
                          <span className="dot" />
                          Courbe de dimensionnement — Batterie minimale par taux
                        </div>
                        <div className="card">
                          <ResponsiveContainer width="100%" height={280}>
                            <AreaChart
                              data={curveData}
                              margin={{
                                top: 10,
                                right: 20,
                                left: 10,
                                bottom: 24,
                              }}
                            >
                              <defs>
                                <linearGradient
                                  id="ggrad"
                                  x1="0"
                                  y1="0"
                                  x2="0"
                                  y2="1"
                                >
                                  <stop
                                    offset="5%"
                                    stopColor="#0d9f6e"
                                    stopOpacity={0.15}
                                  />
                                  <stop
                                    offset="95%"
                                    stopColor="#0d9f6e"
                                    stopOpacity={0}
                                  />
                                </linearGradient>
                              </defs>
                              <CartesianGrid
                                stroke="#e8eef5"
                                strokeDasharray="3 3"
                              />
                              <XAxis
                                dataKey="rate"
                                stroke="#c8d4e3"
                                tickLine={false}
                                tick={{ fontSize: 11, fill: '#7a90a8' }}
                                label={{
                                  value: 'Taux de peak shaving (%)',
                                  position: 'insideBottom',
                                  offset: -12,
                                  fill: '#7a90a8',
                                  fontSize: 11,
                                }}
                              />
                              <YAxis
                                stroke="#c8d4e3"
                                tickLine={false}
                                tick={{ fontSize: 11, fill: '#7a90a8' }}
                                label={{
                                  value: 'Batterie min. (kWh)',
                                  angle: -90,
                                  position: 'insideLeft',
                                  offset: 12,
                                  fill: '#7a90a8',
                                  fontSize: 11,
                                }}
                              />
                              <Tooltip content={<ChartTip unit="kWh" />} />
                              <ReferenceLine
                                x={selectedRate}
                                stroke="#0d9f6e"
                                strokeDasharray="4 3"
                                strokeWidth={1.5}
                              />
                              <Area
                                type="monotone"
                                dataKey="batterySizeKWh"
                                name="Batterie min."
                                stroke="#0d9f6e"
                                strokeWidth={2.5}
                                fill="url(#ggrad)"
                                dot={false}
                              />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      <div className="cfg-panel">
                        <div
                          style={{
                            fontFamily: 'var(--font-h)',
                            fontWeight: 700,
                            fontSize: 14,
                            marginBottom: 18,
                          }}
                        >
                          Scénario sélectionné
                        </div>
                        <div className="cfg-grid">
                          <div>
                            <div className="cfg-label">
                              Taux de peak shaving cible
                            </div>
                            <div className="slider-row">
                              <input
                                type="range"
                                min={0}
                                max={maxRate}
                                value={selectedRate}
                                onChange={(e) =>
                                  setSelectedRate(Number(e.target.value))
                                }
                              />
                              <div className="slider-val">{selectedRate}%</div>
                            </div>
                            <div className="slider-sub">
                              Seuil :{' '}
                              <strong style={{ color: 'var(--text)' }}>
                                {scenario?.thresholdKW?.toFixed(1)} kW
                              </strong>
                              &nbsp;·&nbsp; Batterie :{' '}
                              <strong style={{ color: 'var(--green)' }}>
                                {scenario?.batterySizeKWh?.toFixed(0)} kWh
                              </strong>
                              &nbsp;·&nbsp; Puissance :{' '}
                              <strong style={{ color: 'var(--blue)' }}>
                                {(
                                  (scenario?.batterySizeKWh ?? 0) * C_RATE
                                ).toFixed(0)}{' '}
                                kW
                              </strong>
                              &nbsp;·&nbsp; Prix estimé :{' '}
                              <strong style={{ color: 'var(--amber)' }}>
                                {fmt(scenario?.prix)} CHF
                              </strong>
                            </div>
                          </div>
                          <div className="inp-group">
                            <div className="cfg-label">
                              Tarif puissance réseau
                            </div>
                            <div className="inp-row">
                              <span className="inp-pfx">CHF</span>
                              <DeferredInput
                                type="number"
                                value={prixPuissance}
                                min={0}
                                step={0.5}
                                onChange={(v) => {
                                  setPrixPuissance(v);
                                  handleTariffCommit(prixAchat, prixVente, v);
                                }}
                              />
                              <span
                                className="inp-pfx"
                                style={{
                                  borderLeft: '1px solid var(--border)',
                                  borderRight: 'none',
                                }}
                              >
                                /kW/mois
                              </span>
                            </div>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'center',
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                lineHeight: 2.1,
                              }}
                            >
                              Peak avant :{' '}
                              <strong style={{ color: 'var(--text)' }}>
                                {baseMaxKW.toFixed(1)} kW
                              </strong>
                              <br />
                              Peak après :{' '}
                              <strong style={{ color: 'var(--green)' }}>
                                {scenario?.maxGridKW?.toFixed(1)} kW
                              </strong>
                              <br />
                              Données :{' '}
                              <strong style={{ color: 'var(--text2)' }}>
                                {Math.round(data.length / 96)} jours
                              </strong>
                            </div>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              justifyContent: 'center',
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                lineHeight: 2.1,
                              }}
                            >
                              ROI estimé :{' '}
                              <strong
                                style={{
                                  color: scenario?.roi
                                    ? scenario.roi < 10
                                      ? 'var(--green)'
                                      : 'var(--amber)'
                                    : 'var(--muted)',
                                }}
                              >
                                {scenario?.roi
                                  ? `${scenario.roi.toFixed(1)} ans`
                                  : '—'}
                              </strong>
                              <br />
                              Écon./an :{' '}
                              <strong style={{ color: 'var(--green)' }}>
                                {fmt(scenario?.annualSavings)} CHF
                              </strong>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="sec">
                        <div className="sec-title">
                          <span
                            className="dot"
                            style={{ background: 'var(--blue)' }}
                          />
                          Puissances crêtes mensuelles — Avant / Après
                        </div>
                        <div className="card">
                          <ResponsiveContainer width="100%" height={260}>
                            <BarChart
                              data={monthlyData}
                              margin={{
                                top: 10,
                                right: 20,
                                left: 10,
                                bottom: 5,
                              }}
                            >
                              <CartesianGrid
                                stroke="#e8eef5"
                                strokeDasharray="3 3"
                                vertical={false}
                              />
                              <XAxis
                                dataKey="month"
                                stroke="#c8d4e3"
                                tickLine={false}
                                tick={{ fontSize: 11, fill: '#7a90a8' }}
                              />
                              <YAxis
                                stroke="#c8d4e3"
                                tickLine={false}
                                tick={{ fontSize: 11, fill: '#7a90a8' }}
                                label={{
                                  value: 'kW',
                                  angle: -90,
                                  position: 'insideLeft',
                                  fill: '#7a90a8',
                                  fontSize: 11,
                                }}
                              />
                              <Tooltip content={<ChartTip unit="kW" />} />
                              <Legend
                                wrapperStyle={{ fontSize: 11, paddingTop: 10 }}
                              />
                              <Bar
                                dataKey="avant"
                                name="Sans batterie"
                                fill="#cbd5e1"
                                radius={[3, 3, 0, 0]}
                              />
                              <Bar
                                dataKey="apres"
                                name="Avec batterie"
                                fill="#0d9f6e"
                                radius={[3, 3, 0, 0]}
                              />
                              <ReferenceLine
                                y={scenario?.thresholdKW}
                                stroke="#d97706"
                                strokeDasharray="5 3"
                                strokeWidth={1.5}
                                label={{
                                  value: `Seuil ${scenario?.thresholdKW?.toFixed(
                                    0
                                  )} kW`,
                                  position: 'insideTopRight',
                                  fill: '#d97706',
                                  fontSize: 10,
                                }}
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      <div className="sec">
                        <div className="sec-title">
                          <span
                            className="dot"
                            style={{ background: 'var(--teal)' }}
                          />
                          Tableau complet de dimensionnement
                        </div>
                        <div className="tbl-wrap">
                          <div className="tbl-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>Taux</th>
                                  <th>Seuil (kW)</th>
                                  <th>Batterie (kWh)</th>
                                  <th>Puissance (kW)</th>
                                  <th>Écon. puissance</th>
                                  <th>Écon. énergie</th>
                                  <th>Écon. nettes/an</th>
                                </tr>
                              </thead>
                              <tbody>
                                {points
                                  .filter(
                                    (p, i) =>
                                      i % 5 === 0 || p.rate === selectedRate
                                  )
                                  .map((p) => (
                                    <tr
                                      key={p.rate}
                                      className={
                                        p.rate === selectedRate ? 'sel' : ''
                                      }
                                    >
                                      <td
                                        className={
                                          p.rate === selectedRate ? 'acc' : ''
                                        }
                                      >
                                        {p.rate === selectedRate ? '▶ ' : ''}
                                        {p.rate}%
                                      </td>
                                      <td>{p.thresholdKW} kW</td>
                                      <td
                                        className={
                                          p.rate === selectedRate ? 'acc' : ''
                                        }
                                      >
                                        {p.batterySizeKWh} kWh
                                      </td>
                                      <td>
                                        {(p.batterySizeKWh * C_RATE).toFixed(1)}{' '}
                                        kW
                                      </td>
                                      <td className="blu">
                                        {fmt(p.savingsPuissance)} CHF
                                      </td>
                                      <td>{fmt(p.savingsEnergy)} CHF</td>
                                      <td style={{ fontWeight: 600 }}>
                                        {fmt(p.annualSavings)} CHF
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {/* ══ ROI ══ */}
                  {tab === 'roi' &&
                    (() => {
                      const maxBattInCurve =
                        points[points.length - 1]?.batterySizeKWh ?? 200;
                      const priceCurveMax = Math.min(
                        2000,
                        Math.ceil((maxBattInCurve * 1.2) / 100) * 100
                      );
                      const priceCurveDisplay = buildPriceCurveDisplay(
                        priceAnchors,
                        priceCurveMax
                      );
                      const validRoi = roiCurveData.filter(
                        (d) => d.roi !== null && d.roi < 30
                      );
                      const optPoint = validRoi.length
                        ? validRoi.reduce((b, d) => (d.roi < b.roi ? d : b))
                        : null;

                      return (
                        <>
                          <div
                            className="res-grid"
                            style={{ marginBottom: 24 }}
                          >
                            <div className="rcard hl-green">
                              <div className="rl">
                                Économies nettes annuelles · {selectedRate}%
                              </div>
                              <div className="rv">
                                {fmt(scenario?.annualSavings)} CHF
                              </div>
                              <div className="rs">
                                Puissance : {fmt(scenario?.savingsPuissance)}{' '}
                                CHF &nbsp;·&nbsp; Énergie :{' '}
                                {fmt(scenario?.savingsEnergy)} CHF &nbsp;·&nbsp;
                                Injection : -{fmt(scenario?.lossInjection)} CHF
                              </div>
                            </div>
                            <div
                              className={`rcard ${
                                scenario?.roi
                                  ? scenario.roi < 10
                                    ? 'hl-green'
                                    : 'hl-amber'
                                  : ''
                              }`}
                            >
                              <div className="rl">
                                ROI · {selectedRate}% (avec inflation{' '}
                                {inflation}%)
                              </div>
                              <div className="rv">
                                {scenario?.roi != null
                                  ? `${scenario.roi.toFixed(1)} ans`
                                  : scenario?.prix > 0
                                  ? '> 40 ans'
                                  : '—'}
                              </div>
                              <div className="rs">
                                Investissement : {fmt(scenario?.prix)} CHF ·{' '}
                                {scenario?.batterySizeKWh?.toFixed(0)} kWh
                              </div>
                              {scenario?.roi && (
                                <div className="roi-track">
                                  <div
                                    className="roi-fill"
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        (scenario.roi / 15) * 100
                                      )}%`,
                                      background:
                                        scenario.roi < 8
                                          ? 'var(--green)'
                                          : 'var(--amber)',
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                            <div className="rcard hl-blue">
                              <div className="rl">Taux optimal (ROI min.)</div>
                              <div className="rv">
                                {optPoint ? `${optPoint.rate}%` : '—'}
                              </div>
                              <div className="rs">
                                {optPoint
                                  ? `ROI ${optPoint.roi?.toFixed(1)} ans · ${
                                      optPoint.batterySizeKWh
                                    } kWh · ${fmt(optPoint.batteryPrice)} CHF`
                                  : '—'}
                              </div>
                            </div>
                          </div>

                          {/* Financial params */}
                          <div className="card" style={{ marginBottom: 24 }}>
                            <div
                              style={{
                                fontFamily: 'var(--font-h)',
                                fontWeight: 700,
                                fontSize: 13,
                                marginBottom: 16,
                              }}
                            >
                              Paramètres financiers
                            </div>
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(3,1fr)',
                                gap: 20,
                              }}
                            >
                              {[
                                {
                                  label: 'Inflation annuelle (énergie)',
                                  val: inflation,
                                  set: setInflation,
                                  unit: '%/an',
                                  step: 0.1,
                                },
                                {
                                  label: 'Renchérissement puissance an. 1–5',
                                  val: escal1to5,
                                  set: setEscal1to5,
                                  unit: '%/an',
                                  step: 0.1,
                                },
                                {
                                  label: 'Renchérissement puissance an. 6–10',
                                  val: escal6to10,
                                  set: setEscal6to10,
                                  unit: '%/an',
                                  step: 0.1,
                                },
                              ].map((p) => (
                                <div key={p.label}>
                                  <div className="cfg-label">{p.label}</div>
                                  <div className="inp-row">
                                    <DeferredInput
                                      type="number"
                                      value={p.val}
                                      min={0}
                                      max={20}
                                      step={p.step}
                                      onChange={p.set}
                                    />
                                    <span
                                      className="inp-pfx"
                                      style={{
                                        borderLeft: '1px solid var(--border)',
                                        borderRight: 'none',
                                      }}
                                    >
                                      {p.unit}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: 'var(--muted)',
                                marginTop: 12,
                                lineHeight: 1.8,
                              }}
                            >
                              Le ROI est calculé comme le délai de récupération
                              cumulatif (payback period) avec économies
                              croissantes selon inflation + renchérissement. Les
                              économies sur la puissance bénéficient des deux
                              taux (inflation + renchérissement) ; les économies
                              sur l'énergie bénéficient uniquement de
                              l'inflation.
                            </div>
                          </div>

                          {/* Price curve editor */}
                          <div className="sec">
                            <div className="sec-title">
                              <span
                                className="dot"
                                style={{ background: 'var(--blue)' }}
                              />
                              Courbe de prix batterie — éditable
                            </div>
                            <div className="card">
                              <div
                                style={{
                                  fontSize: 12,
                                  color: 'var(--muted)',
                                  marginBottom: 16,
                                  lineHeight: 1.7,
                                }}
                              >
                                Ajustez les prix unitaires selon les offres
                                reçues. Le ROI se recalcule instantanément.
                                Validez chaque champ avec{' '}
                                <kbd
                                  style={{
                                    background: 'var(--bg2)',
                                    border: '1px solid var(--border2)',
                                    borderRadius: 4,
                                    padding: '1px 5px',
                                    fontSize: 11,
                                  }}
                                >
                                  Entrée
                                </kbd>{' '}
                                ou en cliquant ailleurs.
                              </div>
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: '1fr 1fr',
                                  gap: 24,
                                }}
                              >
                                <div>
                                  <div
                                    className="cfg-label"
                                    style={{ marginBottom: 10 }}
                                  >
                                    Points de contrôle (courbe)
                                  </div>
                                  <table
                                    style={{
                                      width: '100%',
                                      borderCollapse: 'collapse',
                                      fontSize: 12,
                                    }}
                                  >
                                    <thead>
                                      <tr
                                        style={{
                                          borderBottom:
                                            '1px solid var(--border)',
                                        }}
                                      >
                                        <th
                                          style={{
                                            padding: '6px 10px',
                                            textAlign: 'left',
                                            color: 'var(--muted)',
                                            fontWeight: 500,
                                            fontSize: 11,
                                          }}
                                        >
                                          Capacité (kWh)
                                        </th>
                                        <th
                                          style={{
                                            padding: '6px 10px',
                                            textAlign: 'left',
                                            color: 'var(--muted)',
                                            fontWeight: 500,
                                            fontSize: 11,
                                          }}
                                        >
                                          CHF/kWh
                                        </th>
                                        <th
                                          style={{
                                            padding: '6px 10px',
                                            textAlign: 'left',
                                            color: 'var(--muted)',
                                            fontWeight: 500,
                                            fontSize: 11,
                                          }}
                                        >
                                          Prix total
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {priceAnchors.map((a, idx) => (
                                        <tr
                                          key={idx}
                                          style={{
                                            borderBottom:
                                              '1px solid var(--border)',
                                          }}
                                        >
                                          <td
                                            style={{
                                              padding: '5px 10px',
                                              color: 'var(--text2)',
                                            }}
                                          >
                                            {a.kwh} kWh
                                          </td>
                                          <td style={{ padding: '5px 10px' }}>
                                            <div
                                              className="inp-row"
                                              style={{ maxWidth: 110 }}
                                            >
                                              <DeferredInput
                                                type="number"
                                                value={a.chfPerKwh}
                                                min={100}
                                                max={3000}
                                                step={10}
                                                style={{ textAlign: 'right' }}
                                                onChange={(v) => {
                                                  const next = [
                                                    ...priceAnchors,
                                                  ];
                                                  next[idx] = {
                                                    ...next[idx],
                                                    chfPerKwh: v,
                                                  };
                                                  setPriceAnchors(next);
                                                }}
                                              />
                                              <span
                                                className="inp-pfx"
                                                style={{
                                                  borderLeft:
                                                    '1px solid var(--border)',
                                                  borderRight: 'none',
                                                }}
                                              >
                                                CHF
                                              </span>
                                            </div>
                                          </td>
                                          <td
                                            style={{
                                              padding: '5px 10px',
                                              color: 'var(--green)',
                                              fontWeight: 600,
                                            }}
                                          >
                                            {fmt(a.kwh * a.chfPerKwh)} CHF
                                          </td>
                                        </tr>
                                      ))}
                                      {/* Custom battery row */}
                                      <tr
                                        style={{
                                          background: 'var(--amber-l)',
                                          borderTop: '2px solid var(--amber)',
                                        }}
                                      >
                                        <td style={{ padding: '8px 10px' }}>
                                          <div
                                            className="inp-row"
                                            style={{ maxWidth: 110 }}
                                          >
                                            <DeferredInput
                                              type="number"
                                              value={customBattery.kwh}
                                              placeholder="ex: 150"
                                              min={1}
                                              onChange={(v) =>
                                                setCustomBattery((p) => ({
                                                  ...p,
                                                  kwh: v,
                                                }))
                                              }
                                            />
                                            <span
                                              className="inp-pfx"
                                              style={{
                                                borderLeft:
                                                  '1px solid var(--border)',
                                                borderRight: 'none',
                                              }}
                                            >
                                              kWh
                                            </span>
                                          </div>
                                        </td>
                                        <td
                                          style={{
                                            padding: '8px 10px',
                                            color: 'var(--amber)',
                                            fontWeight: 600,
                                            fontSize: 11,
                                          }}
                                        >
                                          Offre spécifique
                                        </td>
                                        <td style={{ padding: '8px 10px' }}>
                                          <div
                                            className="inp-row"
                                            style={{ maxWidth: 130 }}
                                          >
                                            <span className="inp-pfx">CHF</span>
                                            <DeferredInput
                                              type="number"
                                              value={customBattery.price}
                                              placeholder="ex: 95000"
                                              min={1}
                                              onChange={(v) =>
                                                setCustomBattery((p) => ({
                                                  ...p,
                                                  price: v,
                                                }))
                                              }
                                            />
                                          </div>
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                  {customBattValid && (
                                    <div
                                      style={{
                                        marginTop: 8,
                                        fontSize: 11,
                                        color: 'var(--amber)',
                                        background: 'var(--amber-l)',
                                        border: '1px solid #fde68a',
                                        borderRadius: 8,
                                        padding: '6px 12px',
                                      }}
                                    >
                                      ★ Offre spécifique active :{' '}
                                      {customBattValid.kwh} kWh à{' '}
                                      {fmt(customBattValid.price)} CHF &nbsp;(
                                      {fmt(
                                        customBattValid.price /
                                          customBattValid.kwh
                                      )}{' '}
                                      CHF/kWh)
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <div
                                    className="cfg-label"
                                    style={{ marginBottom: 10 }}
                                  >
                                    Courbe prix total (CHF)
                                  </div>
                                  <ResponsiveContainer
                                    width="100%"
                                    height={220}
                                  >
                                    <ComposedChart
                                      data={priceCurveDisplay}
                                      margin={{
                                        top: 5,
                                        right: 10,
                                        left: 10,
                                        bottom: 20,
                                      }}
                                    >
                                      <CartesianGrid
                                        stroke="#e8eef5"
                                        strokeDasharray="3 3"
                                      />
                                      <XAxis
                                        dataKey="kwh"
                                        stroke="#c8d4e3"
                                        tickLine={false}
                                        tick={{ fontSize: 10, fill: '#7a90a8' }}
                                        label={{
                                          value: 'Capacité (kWh)',
                                          position: 'insideBottom',
                                          offset: -10,
                                          fill: '#7a90a8',
                                          fontSize: 10,
                                        }}
                                      />
                                      <YAxis
                                        stroke="#c8d4e3"
                                        tickLine={false}
                                        tick={{ fontSize: 10, fill: '#7a90a8' }}
                                        tickFormatter={(v) =>
                                          `${Math.round(v / 1000)}k`
                                        }
                                        label={{
                                          value: 'Prix (CHF)',
                                          angle: -90,
                                          position: 'insideLeft',
                                          offset: 14,
                                          fill: '#7a90a8',
                                          fontSize: 10,
                                        }}
                                      />
                                      <Tooltip
                                        content={({
                                          active,
                                          payload,
                                          label,
                                        }) => {
                                          if (!active || !payload?.length)
                                            return null;
                                          return (
                                            <div
                                              style={{
                                                background: '#fff',
                                                border: '1px solid #dde4ed',
                                                borderRadius: 8,
                                                padding: '8px 12px',
                                                fontSize: 12,
                                              }}
                                            >
                                              <div
                                                style={{
                                                  color: '#7a90a8',
                                                  marginBottom: 4,
                                                }}
                                              >
                                                {label} kWh
                                              </div>
                                              <strong
                                                style={{ color: '#1a6fbf' }}
                                              >
                                                {fmt(payload[0].value)} CHF
                                              </strong>
                                              <div
                                                style={{
                                                  color: '#7a90a8',
                                                  fontSize: 11,
                                                  marginTop: 2,
                                                }}
                                              >
                                                ≈{' '}
                                                {label > 0
                                                  ? Math.round(
                                                      payload[0].value / label
                                                    )
                                                  : 0}{' '}
                                                CHF/kWh
                                              </div>
                                            </div>
                                          );
                                        }}
                                      />
                                      <Area
                                        type="monotone"
                                        dataKey="totalPrice"
                                        name="Prix total"
                                        stroke="#1a6fbf"
                                        strokeWidth={2}
                                        fill="#1a6fbf15"
                                        dot={false}
                                      />
                                      {priceAnchors.map((a, i) => (
                                        <ReferenceLine
                                          key={i}
                                          x={a.kwh}
                                          stroke="#0d9f6e30"
                                          strokeDasharray="3 2"
                                        />
                                      ))}
                                      {scenario && (
                                        <ReferenceLine
                                          x={Math.round(
                                            scenario.batterySizeKWh
                                          )}
                                          stroke="#0d9f6e"
                                          strokeWidth={1.5}
                                          strokeDasharray="4 3"
                                          label={{
                                            value: `${scenario.batterySizeKWh?.toFixed(
                                              0
                                            )} kWh`,
                                            fill: '#0d9f6e',
                                            fontSize: 10,
                                            position: 'top',
                                          }}
                                        />
                                      )}
                                      {customBattValid && (
                                        <ReferenceLine
                                          x={customBattValid.kwh}
                                          stroke="#d97706"
                                          strokeWidth={2}
                                          strokeDasharray="4 3"
                                          label={{
                                            value: `Offre: ${fmt(
                                              customBattValid.price
                                            )} CHF`,
                                            fill: '#d97706',
                                            fontSize: 10,
                                            position: 'top',
                                          }}
                                        />
                                      )}
                                    </ComposedChart>
                                  </ResponsiveContainer>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Savings + ROI charts */}
                          <div className="two-col">
                            <div className="sec">
                              <div className="sec-title">
                                <span className="dot" />
                                Économies nettes annuelles par taux
                              </div>
                              <div className="card">
                                <ResponsiveContainer width="100%" height={240}>
                                  <ComposedChart
                                    data={roiCurveData}
                                    margin={{
                                      top: 10,
                                      right: 20,
                                      left: 10,
                                      bottom: 20,
                                    }}
                                  >
                                    <CartesianGrid
                                      stroke="#e8eef5"
                                      strokeDasharray="3 3"
                                    />
                                    <XAxis
                                      dataKey="rate"
                                      stroke="#c8d4e3"
                                      tickLine={false}
                                      tick={{ fontSize: 11, fill: '#7a90a8' }}
                                      label={{
                                        value: 'Taux (%)',
                                        position: 'insideBottom',
                                        offset: -10,
                                        fill: '#7a90a8',
                                        fontSize: 11,
                                      }}
                                    />
                                    <YAxis
                                      stroke="#c8d4e3"
                                      tickLine={false}
                                      tick={{ fontSize: 11, fill: '#7a90a8' }}
                                      tickFormatter={(v) =>
                                        `${Math.round(v / 1000)}k`
                                      }
                                    />
                                    <Tooltip
                                      content={<ChartTip unit="CHF/an" />}
                                    />
                                    <ReferenceLine
                                      x={selectedRate}
                                      stroke="#0d9f6e"
                                      strokeDasharray="4 3"
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="savings"
                                      name="Économies nettes"
                                      stroke="#0d9f6e"
                                      strokeWidth={2}
                                      fill="#0d9f6e18"
                                      dot={false}
                                    />
                                  </ComposedChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                            <div className="sec">
                              <div className="sec-title">
                                <span
                                  className="dot"
                                  style={{ background: 'var(--amber)' }}
                                />
                                ROI par taux — avec renchérissement
                              </div>
                              <div className="card">
                                <ResponsiveContainer width="100%" height={240}>
                                  <LineChart
                                    data={validRoi}
                                    margin={{
                                      top: 10,
                                      right: 20,
                                      left: 10,
                                      bottom: 20,
                                    }}
                                  >
                                    <CartesianGrid
                                      stroke="#e8eef5"
                                      strokeDasharray="3 3"
                                    />
                                    <XAxis
                                      dataKey="rate"
                                      stroke="#c8d4e3"
                                      tickLine={false}
                                      tick={{ fontSize: 11, fill: '#7a90a8' }}
                                      label={{
                                        value: 'Taux (%)',
                                        position: 'insideBottom',
                                        offset: -10,
                                        fill: '#7a90a8',
                                        fontSize: 11,
                                      }}
                                    />
                                    <YAxis
                                      stroke="#c8d4e3"
                                      tickLine={false}
                                      tick={{ fontSize: 11, fill: '#7a90a8' }}
                                      label={{
                                        value: 'ROI (ans)',
                                        angle: -90,
                                        position: 'insideLeft',
                                        fill: '#7a90a8',
                                        fontSize: 11,
                                      }}
                                    />
                                    <Tooltip
                                      content={({ active, payload, label }) => {
                                        if (!active || !payload?.length)
                                          return null;
                                        const d = roiCurveData.find(
                                          (x) => x.rate === label
                                        );
                                        return (
                                          <div
                                            style={{
                                              background: '#fff',
                                              border: '1px solid #dde4ed',
                                              borderRadius: 10,
                                              padding: '10px 14px',
                                              fontSize: 12,
                                            }}
                                          >
                                            <div
                                              style={{
                                                color: '#7a90a8',
                                                marginBottom: 6,
                                              }}
                                            >
                                              Taux {label}%
                                            </div>
                                            <div>
                                              ROI :{' '}
                                              <strong
                                                style={{ color: '#d97706' }}
                                              >
                                                {payload[0].value?.toFixed(1)}{' '}
                                                ans
                                              </strong>
                                            </div>
                                            <div
                                              style={{
                                                color: '#3d5166',
                                                marginTop: 3,
                                              }}
                                            >
                                              Batterie : {d?.batterySizeKWh} kWh
                                              · {fmt(d?.batteryPrice)} CHF
                                            </div>
                                            <div style={{ color: '#3d5166' }}>
                                              Écon. : {fmt(d?.savings)} CHF/an
                                            </div>
                                          </div>
                                        );
                                      }}
                                    />
                                    <ReferenceLine
                                      y={10}
                                      stroke="#d97706"
                                      strokeDasharray="4 3"
                                      label={{
                                        value: '10 ans',
                                        fill: '#d97706',
                                        fontSize: 10,
                                        position: 'insideTopRight',
                                      }}
                                    />
                                    <ReferenceLine
                                      x={selectedRate}
                                      stroke="#0d9f6e"
                                      strokeDasharray="4 3"
                                    />
                                    {optPoint && (
                                      <ReferenceLine
                                        x={optPoint.rate}
                                        stroke="#1a6fbf"
                                        strokeDasharray="4 3"
                                        label={{
                                          value: `Optimal ${optPoint.rate}%`,
                                          fill: '#1a6fbf',
                                          fontSize: 10,
                                          position: 'insideTopLeft',
                                        }}
                                      />
                                    )}
                                    <Line
                                      type="monotone"
                                      dataKey="roi"
                                      name="ROI (ans)"
                                      stroke="#d97706"
                                      strokeWidth={2.5}
                                      dot={false}
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                          </div>

                          {/* Full ROI table */}
                          <div className="sec">
                            <div className="sec-title">
                              <span
                                className="dot"
                                style={{ background: 'var(--teal)' }}
                              />
                              Tableau ROI complet
                            </div>
                            <div className="tbl-wrap">
                              <div className="tbl-scroll">
                                <table>
                                  <thead>
                                    <tr>
                                      <th>Taux</th>
                                      <th>Batterie (kWh)</th>
                                      <th>Prix batterie (CHF)</th>
                                      <th>Écon. puissance</th>
                                      <th>Écon. énergie</th>
                                      <th>Écon. nettes/an</th>
                                      <th>ROI</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {roiCurveData
                                      .filter(
                                        (p, i) =>
                                          i % 5 === 0 || p.rate === selectedRate
                                      )
                                      .map((p) => {
                                        const isOpt = optPoint?.rate === p.rate;
                                        const cp = points.find(
                                          (x) => x.rate === p.rate
                                        );
                                        const roiColor =
                                          p.roi == null
                                            ? 'var(--muted)'
                                            : p.roi < 8
                                            ? 'var(--green)'
                                            : p.roi < 12
                                            ? 'var(--amber)'
                                            : 'var(--red)';
                                        return (
                                          <tr
                                            key={p.rate}
                                            className={
                                              p.rate === selectedRate
                                                ? 'sel'
                                                : ''
                                            }
                                            style={
                                              isOpt
                                                ? {
                                                    background: 'var(--blue-l)',
                                                  }
                                                : {}
                                            }
                                          >
                                            <td
                                              className={
                                                p.rate === selectedRate
                                                  ? 'acc'
                                                  : ''
                                              }
                                            >
                                              {isOpt ? '★ ' : ''}
                                              {p.rate === selectedRate
                                                ? '▶ '
                                                : ''}
                                              {p.rate}%
                                            </td>
                                            <td>{p.batterySizeKWh} kWh</td>
                                            <td className="blu">
                                              {fmt(p.batteryPrice)} CHF
                                            </td>
                                            <td
                                              style={{ color: 'var(--green)' }}
                                            >
                                              {fmt(cp?.savingsPuissance)} CHF
                                            </td>
                                            <td>
                                              {fmt(cp?.savingsEnergy)} CHF
                                            </td>
                                            <td style={{ fontWeight: 600 }}>
                                              {fmt(p.savings)} CHF
                                            </td>
                                            <td
                                              style={{
                                                color: roiColor,
                                                fontWeight: 700,
                                              }}
                                            >
                                              {p.roi != null
                                                ? `${p.roi.toFixed(1)} ans`
                                                : p.batteryPrice > 0
                                                ? '> 40'
                                                : '—'}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </div>
                        </>
                      );
                    })()}

                  {/* ══ AUTOCONSOMMATION ══ */}
                  {tab === 'autoconso' &&
                    (() => {
                      const simBase =
                        curve?.base ?? runSim(data, baseMaxKW * 100, 0);
                      return (
                        <>
                          {(simBase.selfConsRate > 0.9 ||
                            simBase.annualPvKWh === 0) && (
                            <div className="info-box">
                              <strong>ℹ️ Profil à forte consommation :</strong>{' '}
                              L'autoconsommation sans batterie est déjà
                              {simBase.annualPvKWh === 0
                                ? ' non applicable (aucune production PV dans ce fichier).'
                                : ` très élevée (${(
                                    simBase.selfConsRate * 100
                                  ).toFixed(
                                    0
                                  )}%) car la consommation dépasse largement la production PV à chaque instant.
                          La batterie n'améliore pas significativement ce taux — sa valeur principale est le peak shaving.`}
                            </div>
                          )}
                          <div
                            className="stats"
                            style={{ gridTemplateColumns: 'repeat(3,1fr)' }}
                          >
                            <div className="scard green">
                              <div className="lbl">
                                Taux autoconsommation · avec batterie
                              </div>
                              <div className="val">
                                {((scenario?.selfConsRate ?? 0) * 100).toFixed(
                                  1
                                )}
                                <span className="unit">%</span>
                              </div>
                              <div className="sub">
                                PV consommé on-site / PV total produit
                              </div>
                            </div>
                            <div className="scard blue">
                              <div className="lbl">
                                Taux d'autarcie · avec batterie
                              </div>
                              <div className="val">
                                {((scenario?.autarkyRate ?? 0) * 100).toFixed(
                                  1
                                )}
                                <span className="unit">%</span>
                              </div>
                              <div className="sub">
                                Conso couverte par PV / Conso totale
                              </div>
                            </div>
                            <div className="scard teal">
                              <div className="lbl">
                                Gain autoconsommation vs. sans batterie
                              </div>
                              <div className="val">
                                +
                                {(
                                  ((scenario?.selfConsRate ?? 0) -
                                    (simBase.selfConsRate ?? 0)) *
                                  100
                                ).toFixed(1)}
                                <span className="unit">pp</span>
                              </div>
                              <div className="sub">
                                par rapport à installation PV seule
                              </div>
                            </div>
                          </div>

                          <div className="sec">
                            <div className="sec-title">
                              <span className="dot" />
                              Comparaison : Sans batterie vs Avec batterie (
                              {selectedRate}%)
                            </div>
                            <div className="card">
                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: '1fr 1fr',
                                  gap: 32,
                                  padding: '8px 0',
                                }}
                              >
                                {[
                                  {
                                    label: 'Sans batterie',
                                    sc: simBase.selfConsRate,
                                    au: simBase.autarkyRate,
                                    color: '#cbd5e1',
                                    textColor: '#7a90a8',
                                  },
                                  {
                                    label: `Avec batterie (${selectedRate}%)`,
                                    sc: scenario?.selfConsRate ?? 0,
                                    au: scenario?.autarkyRate ?? 0,
                                    color: '#0d9f6e',
                                    textColor: '#0d9f6e',
                                  },
                                ].map((col) => (
                                  <div key={col.label}>
                                    <div
                                      style={{
                                        fontFamily: 'var(--font-h)',
                                        fontWeight: 700,
                                        fontSize: 14,
                                        color: col.textColor,
                                        marginBottom: 16,
                                      }}
                                    >
                                      {col.label}
                                    </div>
                                    {[
                                      {
                                        lbl: "TAUX D'AUTOCONSOMMATION",
                                        val: col.sc,
                                        color: col.color,
                                      },
                                      {
                                        lbl: "TAUX D'AUTARCIE",
                                        val: col.au,
                                        color: '#1a6fbf',
                                      },
                                    ].map((g) => (
                                      <div
                                        key={g.lbl}
                                        style={{ marginBottom: 16 }}
                                      >
                                        <div
                                          style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            fontSize: 11,
                                            fontWeight: 600,
                                            color: 'var(--muted)',
                                            marginBottom: 6,
                                          }}
                                        >
                                          <span>{g.lbl}</span>
                                          <span
                                            style={{
                                              color: col.textColor,
                                              fontSize: 15,
                                              fontFamily: 'var(--font-h)',
                                              fontWeight: 700,
                                            }}
                                          >
                                            {(g.val * 100).toFixed(1)}%
                                          </span>
                                        </div>
                                        <div
                                          style={{
                                            height: 12,
                                            background: 'var(--bg2)',
                                            borderRadius: 6,
                                            overflow: 'hidden',
                                          }}
                                        >
                                          <div
                                            style={{
                                              width: `${Math.min(
                                                100,
                                                g.val * 100
                                              ).toFixed(1)}%`,
                                              height: '100%',
                                              background: g.color,
                                              borderRadius: 6,
                                              transition: 'width .6s',
                                            }}
                                          />
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div className="two-col">
                            <div className="sec">
                              <div className="sec-title">
                                <span className="dot" />
                                Autoconsommation & autarcie par taux de peak
                                shaving
                              </div>
                              <div className="card">
                                <ResponsiveContainer width="100%" height={240}>
                                  <LineChart
                                    data={roiCurveData}
                                    margin={{
                                      top: 10,
                                      right: 20,
                                      left: 10,
                                      bottom: 20,
                                    }}
                                  >
                                    <CartesianGrid
                                      stroke="#e8eef5"
                                      strokeDasharray="3 3"
                                    />
                                    <XAxis
                                      dataKey="rate"
                                      stroke="#c8d4e3"
                                      tickLine={false}
                                      tick={{ fontSize: 11, fill: '#7a90a8' }}
                                      label={{
                                        value: 'Taux peak shaving (%)',
                                        position: 'insideBottom',
                                        offset: -10,
                                        fill: '#7a90a8',
                                        fontSize: 11,
                                      }}
                                    />
                                    <YAxis
                                      stroke="#c8d4e3"
                                      tickLine={false}
                                      tick={{ fontSize: 11, fill: '#7a90a8' }}
                                      domain={[0, 100]}
                                      label={{
                                        value: '%',
                                        angle: -90,
                                        position: 'insideLeft',
                                        fill: '#7a90a8',
                                        fontSize: 11,
                                      }}
                                    />
                                    <Tooltip content={<ChartTip unit="%" />} />
                                    <ReferenceLine
                                      x={selectedRate}
                                      stroke="#0d9f6e"
                                      strokeDasharray="4 3"
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="selfCons"
                                      name="Autoconsommation"
                                      stroke="#0d9f6e"
                                      strokeWidth={2.5}
                                      dot={false}
                                    />
                                    <Line
                                      type="monotone"
                                      dataKey="autarky"
                                      name="Autarcie"
                                      stroke="#1a6fbf"
                                      strokeWidth={2.5}
                                      dot={false}
                                      strokeDasharray="5 3"
                                    />
                                    <Legend
                                      wrapperStyle={{
                                        fontSize: 11,
                                        paddingTop: 8,
                                      }}
                                    />
                                  </LineChart>
                                </ResponsiveContainer>
                              </div>
                            </div>
                            <div className="sec">
                              <div className="sec-title">
                                <span
                                  className="dot"
                                  style={{ background: 'var(--blue)' }}
                                />
                                Bilan énergétique annuel
                              </div>
                              <div className="card">
                                <div
                                  style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: 14,
                                    padding: '4px 0',
                                  }}
                                >
                                  {[
                                    {
                                      label: 'Production PV totale',
                                      val: scenario?.annualPvKWh,
                                      color: '#f59e0b',
                                    },
                                    {
                                      label: 'Consommation totale',
                                      val: scenario?.annualConsoKWh,
                                      color: '#1a6fbf',
                                    },
                                    {
                                      label: 'Achat réseau',
                                      val: scenario?.annualGridKWh,
                                      color: '#dc2626',
                                    },
                                    {
                                      label: 'Injection réseau',
                                      val: scenario?.annualInjKWh,
                                      color: '#0d9f6e',
                                    },
                                    {
                                      label: 'PV auto-consommé',
                                      val: scenario?.annualSelfConsKWh,
                                      color: '#0891b2',
                                    },
                                  ].map((row) => {
                                    const max = Math.max(
                                      scenario?.annualPvKWh || 1,
                                      scenario?.annualConsoKWh || 1
                                    );
                                    return (
                                      <div key={row.label}>
                                        <div
                                          style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            fontSize: 12,
                                            marginBottom: 4,
                                          }}
                                        >
                                          <span
                                            style={{ color: 'var(--text2)' }}
                                          >
                                            {row.label}
                                          </span>
                                          <strong style={{ color: row.color }}>
                                            {fmt(row.val)} kWh
                                          </strong>
                                        </div>
                                        <div
                                          style={{
                                            height: 7,
                                            background: 'var(--bg2)',
                                            borderRadius: 4,
                                            overflow: 'hidden',
                                          }}
                                        >
                                          <div
                                            style={{
                                              width: `${Math.min(
                                                100,
                                                ((row.val || 0) / max) * 100
                                              )}%`,
                                              height: '100%',
                                              background: row.color,
                                              borderRadius: 4,
                                              opacity: 0.8,
                                            }}
                                          />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        </>
                      );
                    })()}

                  {/* ══ PARAMS ══ */}
                  {tab === 'params' && (
                    <div style={{ maxWidth: 700 }}>
                      <div className="card">
                        <div
                          style={{
                            fontFamily: 'var(--font-h)',
                            fontWeight: 700,
                            fontSize: 15,
                            marginBottom: 20,
                          }}
                        >
                          Paramètres tarifaires
                        </div>
                        <div className="info-box">
                          Validez chaque champ avec{' '}
                          <kbd
                            style={{
                              background: '#fff',
                              border: '1px solid #bfdbfe',
                              borderRadius: 4,
                              padding: '1px 5px',
                            }}
                          >
                            Entrée
                          </kbd>{' '}
                          ou en cliquant ailleurs — le recalcul se déclenche
                          alors.
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 20,
                          }}
                        >
                          {[
                            {
                              label: "Tarif d'achat de l'électricité",
                              val: prixAchat,
                              set: (v) => {
                                setPrixAchat(v);
                                handleTariffCommit(v, prixVente, prixPuissance);
                              },
                              unit: 'kWh',
                              step: 0.01,
                            },
                            {
                              label: 'Tarif de vente (injection réseau)',
                              val: prixVente,
                              set: (v) => {
                                setPrixVente(v);
                                handleTariffCommit(prixAchat, v, prixPuissance);
                              },
                              unit: 'kWh',
                              step: 0.01,
                            },
                            {
                              label: 'Tarif de puissance réseau',
                              val: prixPuissance,
                              set: (v) => {
                                setPrixPuissance(v);
                                handleTariffCommit(prixAchat, prixVente, v);
                              },
                              unit: 'kW/mois',
                              step: 0.5,
                            },
                          ].map((p) => (
                            <div key={p.label}>
                              <div className="cfg-label">{p.label}</div>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 12,
                                }}
                              >
                                <div
                                  className="inp-row"
                                  style={{ maxWidth: 200 }}
                                >
                                  <span className="inp-pfx">CHF</span>
                                  <DeferredInput
                                    type="number"
                                    value={p.val}
                                    min={0}
                                    step={p.step}
                                    onChange={p.set}
                                  />
                                  <span
                                    className="inp-pfx"
                                    style={{
                                      borderLeft: '1px solid var(--border)',
                                      borderRight: 'none',
                                    }}
                                  >
                                    /{p.unit}
                                  </span>
                                </div>
                              </div>
                            </div>
                          ))}

                          <div
                            style={{
                              marginTop: 8,
                              padding: '16px',
                              background: 'var(--surface2)',
                              borderRadius: 10,
                              border: '1px solid var(--border)',
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: 'var(--text2)',
                                marginBottom: 8,
                              }}
                            >
                              Paramètres batterie (fixes)
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                lineHeight: 2,
                              }}
                            >
                              C-Rate max :{' '}
                              <strong style={{ color: 'var(--text)' }}>
                                {C_RATE}
                              </strong>
                              <br />
                              Rendement charge :{' '}
                              <strong style={{ color: 'var(--text)' }}>
                                {ETA_CHARGE * 100}%
                              </strong>
                              <br />
                              Rendement décharge :{' '}
                              <strong style={{ color: 'var(--text)' }}>
                                {ETA_DISCHARGE * 100}%
                              </strong>
                              <br />
                              Rendement aller-retour :{' '}
                              <strong style={{ color: 'var(--text)' }}>
                                {(ETA_CHARGE * ETA_DISCHARGE * 100).toFixed(1)}%
                              </strong>
                            </div>
                          </div>

                          <div
                            style={{
                              padding: '16px',
                              background: 'var(--surface2)',
                              borderRadius: 10,
                              border: '1px solid var(--border)',
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: 'var(--text2)',
                                marginBottom: 8,
                              }}
                            >
                              Stratégie EMS (Energy Management System)
                            </div>
                            <div
                              style={{
                                fontSize: 12,
                                color: 'var(--muted)',
                                lineHeight: 1.9,
                              }}
                            >
                              <strong style={{ color: 'var(--text)' }}>
                                1. Décharge peak shaving
                              </strong>{' '}
                              — La batterie se décharge dès que la puissance
                              réseau dépasse le seuil.
                              <br />
                              <strong style={{ color: 'var(--text)' }}>
                                2. Charge PV surplus
                              </strong>{' '}
                              — Le surplus solaire charge la batterie en
                              priorité.
                              <br />
                              <strong style={{ color: 'var(--text)' }}>
                                3. Charge préventive nocturne
                              </strong>{' '}
                              — Si la batterie est insuffisamment chargée et
                              qu'un pic est prévu dans les 4h, elle se charge
                              depuis le réseau de nuit (22h–7h).
                              <br />
                              Cette stratégie est plus agressive qu'un simple
                              EMS réactif.
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
        </div>
      </div>
    </>
  );
}
