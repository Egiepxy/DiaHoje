// QNT EGI — auditoria automatizada, 100% fictícia e sem ordens.
// Reproduz as regras congeladas de apps/Simulador_QNT_EGI_V1_3_Robustez.html.
// Sem chaves de exchange e sem integração de negociação.
import { mkdir, writeFile } from "node:fs/promises";

const DAY = 86400000, H4 = 14400000, H1 = 3600000;
const CUT = 1793217599999; // 28/10/2026 19:59:59.999 UTC
const INITIAL = 100, CONF = 3, REST = 2;
const SERVERS = ["https://data-api.binance.vision", "https://api.binance.com"];
const COSTS = [
  { name: "NORMAL", fee: 10, slip: 5 },
  { name: "ESTRESSE", fee: 25, slip: 15 },
  { name: "SEVERO", fee: 50, slip: 30 }
];
const FULL = process.env.QNT_FULL === "true" || (process.env.QNT_FULL !== "false" && new Date().getUTCDay() === 1);
const OUTPUT = "relatorios/qnt-egi";
const fmt = (v, d = 2) => Number.isFinite(v) ? v.toFixed(d) : "—";
const stamp = ms => new Date(ms).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(tf, limit, end) {
  const errors = [];
  for (const host of SERVERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const url = host + "/api/v3/klines?symbol=QNTUSDT&interval=" + tf + "&limit=" + limit + "&endTime=" + end;
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw Error("HTTP " + response.status);
      const raw = await response.json();
      if (!Array.isArray(raw) || raw.length === 0) throw Error("Resposta vazia");
      const parsed = raw.map(r => ({
        openTime: Number(r[0]), open: Number(r[1]), h: Number(r[2]),
        l: Number(r[3]), c: Number(r[4]), v: Number(r[7]), t: Number(r[6])
      }));
      if (parsed.some(r => ![r.openTime, r.open, r.h, r.l, r.c, r.v, r.t].every(Number.isFinite) ||
          r.open <= 0 || r.c <= 0 || r.v < 0 || r.h < r.l)) throw Error("Dados inválidos");
      return parsed;
    } catch (error) {
      errors.push(host + ": " + error.message);
    } finally {
      clearTimeout(timer);
    }
  }
  throw Error("Falha " + tf + ": " + errors.join(" / "));
}

async function history(tf, latestClose, firstRequired, now) {
  const step = tf === "4h" ? H4 : H1;
  let end = latestClose;
  const seen = new Set(), rows = [];
  for (let page = 0; page < 12; page++) {
    const pageRows = await request(tf, 1000, end);
    for (const r of pageRows) {
      if (r.t <= latestClose && r.t < now - 1500 && !seen.has(r.t)) {
        rows.push(r); seen.add(r.t);
      }
    }
    if (!rows.length) throw Error("Nenhum candle fechado em " + tf);
    if (Math.min(...rows.map(r => r.t)) <= firstRequired) break;
    if (page === 11) throw Error("Histórico " + tf + " insuficiente para a janela histórica.");
    const earliest = pageRows[0].openTime;
    if (earliest <= 0 || earliest >= end) throw Error("Paginação inválida em " + tf);
    end = earliest - 1;
    await sleep(150);
  }
  rows.sort((a, b) => a.t - b.t);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].openTime - rows[i - 1].openTime !== step) {
      throw Error("Lacuna/duplicidade de candles " + tf + " próximo de " + stamp(rows[i].t));
    }
  }
  return rows;
}

function ema(values, n) {
  const k = 2 / (n + 1), result = [];
  let v = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i) v = v * (1 - k) + values[i] * k;
    result.push(v);
  }
  return result;
}

function rsi(values, n = 14) {
  const result = Array(values.length).fill(null);
  if (values.length < n + 1) return result;
  let up = 0, down = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    up += Math.max(d, 0); down += Math.max(-d, 0);
  }
  up /= n; down /= n;
  const value = () => down === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / down);
  result[n] = value();
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    up = (up * (n - 1) + Math.max(d, 0)) / n;
    down = (down * (n - 1) + Math.max(-d, 0)) / n;
    result[i] = value();
  }
  return result;
}

function prepare(four, one) {
  const A = { e9: ema(four.map(r => r.c), 9), e21: ema(four.map(r => r.c), 21), rsi: rsi(four.map(r => r.c)) };
  const B = { e9: ema(one.map(r => r.c), 9), e21: ema(one.map(r => r.c), 21) };
  const out = [];
  let j = -1;
  for (let i = 0; i < four.length; i++) {
    while (j + 1 < one.length && one[j + 1].t <= four[i].t) j++;
    if (i < 65 || j < 60) continue;
    const vrbase = four.slice(i - 20, i).reduce((sum, r) => sum + r.v, 0) / 20;
    const vr = vrbase > 0 ? four[i].v / vrbase : 0;
    const bear = four[i].c < A.e21[i] && four[i - 1].c < A.e21[i - 1] &&
      A.e9[i] < A.e21[i] && B.e9[j] < B.e21[j] && A.rsi[i] < 45 && vr >= 1;
    const bull = four[i].c > A.e21[i] && four[i - 1].c > A.e21[i - 1] &&
      A.e9[i] > A.e21[i] && B.e9[j] > B.e21[j] && A.rsi[i] > 55 && vr >= 1.2;
    out.push({ bar: four[i], vr, bear, bull });
  }
  return out;
}

function runPeriod(prepared, startExclusive, endInclusive, cost, variant) {
  const steps = prepared.filter(x => x.bar.t > startExclusive && x.bar.t <= endInclusive);
  if (steps.length < 10) throw Error("Menos de 10 candles válidos na janela.");
  const fee = cost.fee / 10000, slip = cost.slip / 10000, first = steps[0].bar;
  const buyPrice = first.open * (1 + slip);
  let qnt = INITIAL / (buyPrice * (1 + fee)), cash = 0, sold = 0, totalFees = qnt * buyPrice * fee;
  const holdQty = qnt, events = [{ t: first.openTime, action: "COMPRA INICIAL", price: buyPrice, qty: qnt, fee: totalFees }];
  let pending = null, lastExec = -999, bearStreak = 0, bullStreak = 0;
  let peak = INITIAL, holdPeak = INITIAL, dd = 0, holdDD = 0;
  for (let idx = 0; idx < steps.length; idx++) {
    const s = steps[idx], bar = s.bar;
    if (pending) {
      if (pending.action === "VENDA PARCIAL") {
        const qty = qnt * 0.5, price = bar.open * (1 - slip), gross = qty * price, tax = gross * fee;
        qnt -= qty; cash += gross - tax; sold = qty; totalFees += tax;
        events.push({ t: bar.openTime, action: pending.action, price, qty, fee: tax, signalTime: pending.t });
      } else {
        const price = bar.open * (1 + slip), qty = Math.min(sold, cash / (price * (1 + fee)));
        if (qty > 1e-12) {
          const debit = qty * price * (1 + fee), tax = qty * price * fee;
          qnt += qty; cash = Math.max(0, cash - debit); totalFees += tax;
          events.push({ t: bar.openTime, action: pending.action, price, qty, fee: tax, signalTime: pending.t });
        }
        sold = 0;
      }
      lastExec = idx; pending = null;
    }
    const eq = cash + qnt * bar.c, hold = holdQty * bar.c;
    peak = Math.max(peak, eq); holdPeak = Math.max(holdPeak, hold);
    dd = Math.max(dd, (peak - eq) / peak * 100);
    holdDD = Math.max(holdDD, (holdPeak - hold) / holdPeak * 100);
    bearStreak = s.bear ? bearStreak + 1 : 0;
    bullStreak = s.bull ? bullStreak + 1 : 0;
    const ready = idx - lastExec > REST;
    const proposal = variant === "V1.1"
      ? (!sold && s.bear ? "VENDA PARCIAL" : sold && s.bull ? "RECOMPRA" : null)
      : (ready && !sold && bearStreak >= CONF ? "VENDA PARCIAL" :
         ready && sold && bullStreak >= CONF ? "RECOMPRA" : null);
    if (proposal) pending = { action: proposal, t: bar.t };
  }
  const end = steps[steps.length - 1].bar, eq = cash + qnt * end.c, hold = holdQty * end.c;
  return {
    equity: eq, hold, vsHold: eq - hold, dd, holdDD, fees: totalFees,
    events, qnt, cash, number: steps.length, pending: pending?.action || null,
    start: steps[0].bar.openTime, end: end.t, variation: (end.c / first.open - 1) * 100
  };
}

function compare(prepared, start, end, costs) {
  return costs.map(cost => ({
    cost,
    strategy: runPeriod(prepared, start, end, cost, "V1.3"),
    base: runPeriod(prepared, start, end, cost, "V1.1")
  }));
}

function formatReport(result) {
  const lines = [
    "RELGPT — QNT EGI — TESTES AUTOMÁTICOS — 100% FICTÍCIO — NÃO ORDEM",
    "Gerado: " + result.generated + " | Último candle 4h: " + stamp(result.anchor),
    "Ativo QNTUSDT | Binance Spot pública | candles fechados 4h e 1h",
    "Configuração CONGELADA: 3 confirmações + 2 candles 4h de descanso",
    "Corte prospectivo FIXO: " + stamp(CUT) + " | " + CUT,
    "Execução automática: " + (result.full ? "DIÁRIA + ROBUSTEZ SEMANAL" : "DIÁRIA"),
    "Dados: 4h " + result.candles4h + " | 1h " + result.candles1h,
    "Sem chave, sem ordens, sem futuros, sem alavancagem.",
    ""
  ];
  for (const group of result.groups) {
    lines.push(group.label + " (" + group.kind + ") | " + stamp(group.start) + " a " + stamp(group.end));
    if (!group.runs.length) {
      lines.push("  AMOSTRA INSUFICIENTE: " + group.count + " candles novos; mínimo operacional da simulação: 10.");
      continue;
    }
    lines.push("  Candles novos " + group.count + " | Mínimo prospectivo 180: " + (group.count >= 180 ? "ATINGIDO (não implica aprovação)" : "PENDENTE"));
    for (const x of group.runs) {
      const a = x.strategy, b = x.base;
      lines.push(
        "  " + x.cost.name + " (taxa " + x.cost.fee + "bps/slip " + x.cost.slip + "bps)" +
        " | 3+2: " + fmt(a.equity) + " USDT" +
        " | V1.1: " + fmt(b.equity) + " USDT" +
        " | HOLD: " + fmt(a.hold) + " USDT" +
        " | vs HOLD: " + fmt(a.vsHold) + " USDT" +
        " | drawdown 3+2: " + fmt(a.dd) + "%" +
        " | drawdown HOLD: " + fmt(a.holdDD) + "%" +
        " | taxas: " + fmt(a.fees) + " USDT" +
        " | operações (inclui compra inicial): " + a.events.length +
        " | pendente: " + (a.pending || "NÃO")
      );
      if (x.cost.name === "NORMAL" && group.kind === "PROSPECTIVA") {
        for (const ev of a.events) {
          lines.push("    " + stamp(ev.t) + " | " + ev.action + " | QNT " + fmt(ev.qty, 6) +
            " @ " + fmt(ev.price) + " | taxa " + fmt(ev.fee, 4));
        }
      }
    }
  }
  lines.push("", "Limitações: execução hipotética na abertura do próximo candle; carteira fictícia reinicia em 100 USDT em cada janela.");
  lines.push("Desempenho histórico não prevê futuro. Não modela livro de ofertas, lotes mínimos, impostos, latência ou preços intrabar.");
  lines.push("Janelas anteriores ao corte são retrospectivas, nunca evidência fora da amostra. Não mudar parâmetros para otimizar resultado passado.");
  return lines.join("\n") + "\n";
}

async function output(json, report) {
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(OUTPUT + "/ultimo.json", JSON.stringify(json, null, 2) + "\n");
  await writeFile(OUTPUT + "/RelGPT_QNT.txt", report);
  console.log(report);
}

async function main() {
  const now = Date.now();
  if (now <= CUT) throw Error("Relógio anterior à data de corte.");
  const recent = (await request("4h", 4, now)).filter(r => r.t < now - 1500);
  if (!recent.length) throw Error("Último candle 4h fechado não encontrado.");
  const anchor = recent[recent.length - 1].t;
  if (anchor < CUT) throw Error("Ainda não houve candle após o corte.");
  // Mesmo aquecimento e mesma âncora usados no HTML V1.3.
  const firstRequired = FULL ? CUT - 111 * DAY : CUT - 15 * DAY;
  const [four, one] = await Promise.all([
    history("4h", anchor, firstRequired, now),
    history("1h", anchor, firstRequired, now)
  ]);
  if (four.at(-1)?.t !== anchor || one.at(-1)?.t !== anchor) {
    throw Error("Âncoras 1h e 4h divergentes. Teste bloqueado para evitar dados desalinhados.");
  }
  const prepared = prepare(four, one);
  const groups = [];
  if (FULL) {
    for (let i = 3; i >= 1; i--) {
      const start = CUT - i * 30 * DAY, end = CUT - (i - 1) * 30 * DAY;
      const count = prepared.filter(x => x.bar.t > start && x.bar.t <= end).length;
      if (count < 165) throw Error("Janela histórica incompleta: " + stamp(start) + " a " + stamp(end));
      groups.push({
        label: "HISTÓRICA " + (4 - i) + "/3",
        kind: "RETROSPECTIVA", start, end, count,
        runs: compare(prepared, start, end, COSTS)
      });
    }
  }
  const count = prepared.filter(x => x.bar.t > CUT && x.bar.t <= anchor).length;
  groups.push({
    label: "PÓS-CORTE 28/10/2026", kind: "PROSPECTIVA",
    start: CUT, end: anchor, count,
    runs: count < 10 ? [] : compare(prepared, CUT, anchor, FULL ? COSTS : [COSTS[0]])
  });
  const result = {
    app: "QNT_EGI_TESTES_AUTOMATICOS",
    generated: new Date().toISOString(), cutoff: CUT, anchor,
    symbol: "QNTUSDT", initialCapitalUSDT: INITIAL, confirmation: CONF, rest: REST,
    full: FULL, candles4h: four.length, candles1h: one.length, groups
  };
  await output(result, formatReport(result));
}

try {
  await main();
} catch (error) {
  const message = "RELGPT — QNT EGI — TESTE BLOQUEADO — NENHUM RESULTADO INVENTADO\n" +
    "Gerado: " + new Date().toISOString() + "\nMotivo: " + error.message + "\n";
  await output({ status: "FALHA", error: error.message, generated: new Date().toISOString() }, message);
  process.exitCode = 1;
}
