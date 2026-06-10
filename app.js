/* ============================================================
   BIOBORO — трекер плана. Вся логика и расчёты.
   Ванильный JS. Графики — Chart.js. Источник — data.json.
   ============================================================ */

'use strict';

/* ---- Метрики: что показываем как «план vs факт» ---- */
const METRICS = {
  revenue_buyouts: { label: 'Выручка (выкупы)', field: 'revenue_buyouts', plan: 'revenue_buyouts', money: true },
  revenue_orders:  { label: 'Выручка (заказы)', field: 'revenue_orders',  plan: 'revenue_orders',  money: true },
  net_revenue:     { label: 'Чистая выручка',   field: 'net_revenue',     plan: 'net_revenue',     money: true },
  orders_count:    { label: 'Заказы (шт)',       field: 'orders_count',    plan: 'orders_count',    money: false },
  buyouts_count:   { label: 'Выкупы (шт)',       field: 'buyouts_count',   plan: 'buyouts_count',   money: false },
};

const MONTH_NAMES = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const MONTH_GEN   = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

/* ---- Глобальное состояние ---- */
const state = { db: null, month: null, channel: 'all', metric: 'revenue_buyouts', today: null };
const charts = { cumulative: null, channels: null };

/* ============================================================
   Форматирование
   ============================================================ */
const RUB = new Intl.NumberFormat('ru-RU');
function fmtMoney(v) { return RUB.format(Math.round(v)) + ' ₽'; }
function fmtNum(v)   { return RUB.format(Math.round(v)); }
function fmtVal(v, money) { return money ? fmtMoney(v) : fmtNum(v) + ' шт'; }
function fmtPct(v, digits = 1) { return (v >= 0 ? '' : '') + v.toFixed(digits) + '%'; }
function fmtSigned(v, money) { const s = v >= 0 ? '+' : '−'; return s + (money ? fmtMoney(Math.abs(v)) : fmtNum(Math.abs(v)) + ' шт'); }
function fmtSignedPct(v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%'; }

/* ============================================================
   Утилиты по датам
   ============================================================ */
function daysInMonth(year, month1) { return new Date(year, month1, 0).getDate(); } // month1: 1..12
function parseMonthKey(key) { const [y, m] = key.split('-').map(Number); return { y, m }; }
function prevMonthKey(key) { let { y, m } = parseMonthKey(key); m -= 1; if (m === 0) { m = 12; y -= 1; } return `${y}-${String(m).padStart(2, '0')}`; }

// «Текущий день» для месяца: для реального текущего месяца — сегодняшнее число,
// для прошлого месяца — он завершён (= число дней), для будущего — 0.
function currentDayFor(monthKey) {
  const { y, m } = parseMonthKey(monthKey);
  const dim = daysInMonth(y, m);
  const ref = state.today || todayISO();   // выбранная «точка отсчёта»
  const refKey = ref.slice(0, 7);
  const refDay = Number(ref.slice(8, 10));
  if (monthKey === refKey) return Math.min(refDay, dim);
  if (monthKey < refKey) return dim;   // прошлый — завершён
  return 0;                             // будущий
}

/* ============================================================
   Агрегация: строки месяца -> массив по дням
   Возвращает per-day суммы всех базовых полей.
   ============================================================ */
const BASE_FIELDS = ['revenue_orders','revenue_buyouts','orders_count','buyouts_count','ad_spend','logistics','commissions','penalties','other_costs','net_revenue'];

function aggregateByDay(monthKey, channel) {
  const { y, m } = parseMonthKey(monthKey);
  const dim = daysInMonth(y, m);
  const days = Array.from({ length: dim }, () => { const o = {}; BASE_FIELDS.forEach(f => o[f] = 0); o._has = false; return o; });
  for (const r of state.db.data) {
    if (!r.date.startsWith(monthKey)) continue;
    if (channel !== 'all' && r.channel !== channel) continue;
    const d = Number(r.date.slice(8, 10)) - 1;
    if (d < 0 || d >= dim) continue;
    BASE_FIELDS.forEach(f => days[d][f] += (r[f] || 0));
    days[d]._has = true;
  }
  return { days, dim };
}

// Сумма выбранного поля по дням 1..upTo (включительно)
function sumField(days, field, upTo) {
  let s = 0;
  for (let i = 0; i < upTo && i < days.length; i++) s += days[i][field];
  return s;
}

/* ============================================================
   Доля канала в плане.
   Планы заданы на месяц целиком. Если выбран один канал — берём
   его долю в плане пропорционально факту прошлого месяца (а если
   данных нет — пропорционально его доле в текущем факте).
   Для «Все каналы» доля = 1.
   ============================================================ */
function channelPlanShare(monthKey, channel, planField) {
  if (channel === 'all') return 1;
  const field = METRICS[state.metric].field;
  function shareIn(mk) {
    let total = 0, ch = 0;
    for (const r of state.db.data) {
      if (!r.date.startsWith(mk)) continue;
      total += r[field] || 0;
      if (r.channel === channel) ch += r[field] || 0;
    }
    return total > 0 ? ch / total : null;
  }
  return shareIn(prevMonthKey(monthKey)) ?? shareIn(monthKey) ?? (1 / state.db.meta.channels.length);
}

/* ============================================================
   Главный расчёт по месяцу
   ============================================================ */
function compute(monthKey, channel, metricKey) {
  const M = METRICS[metricKey];
  const { days, dim } = aggregateByDay(monthKey, channel);
  const curDay = currentDayFor(monthKey);

  const plansRaw = state.db.plans[monthKey] || {};
  const planShare = channelPlanShare(monthKey, channel, M.plan);
  const monthlyPlan = (plansRaw[M.plan] || 0) * planShare;

  // Формулы 1–7
  const dailyPlan = dim > 0 ? monthlyPlan / dim : 0;                    // (1)
  const cumPlanToday = dailyPlan * curDay;                             // (2)
  const actualCum = sumField(days, M.field, curDay);                  // факт накопит.
  const planCompletion = cumPlanToday > 0 ? actualCum / cumPlanToday * 100 : 0; // (3)
  const monthCompletion = monthlyPlan > 0 ? actualCum / monthlyPlan * 100 : 0;  // (4)
  const dailyAvgActual = curDay > 0 ? actualCum / curDay : 0;          // (5)
  const forecast = dailyAvgActual * dim;                              // (6)
  const forecastGap = forecast - monthlyPlan;                         // (7)

  const deviationRub = actualCum - cumPlanToday;
  const deviationPct = cumPlanToday > 0 ? deviationRub / cumPlanToday * 100 : 0;

  // Дотянуть до плана прямо сейчас + нужный темп до конца месяца
  const catchUp = Math.max(0, cumPlanToday - actualCum);
  const remainingDays = Math.max(0, dim - curDay);
  const requiredRunRate = remainingDays > 0 ? Math.max(0, (monthlyPlan - actualCum) / remainingDays) : 0;

  // Доп. KPI накопительно за текущий период (всегда из базовых полей)
  const cum = {};
  BASE_FIELDS.forEach(f => cum[f] = sumField(days, f, curDay));
  const avgOrderValue = cum.orders_count > 0 ? cum.revenue_orders / cum.orders_count : 0;   // (9)
  const avgBuyoutValue = cum.buyouts_count > 0 ? cum.revenue_buyouts / cum.buyouts_count : 0; // (10)
  const buyoutRate = cum.orders_count > 0 ? cum.buyouts_count / cum.orders_count * 100 : 0;   // (8)
  const drr = cum.revenue_orders > 0 ? cum.ad_spend / cum.revenue_orders * 100 : 0;           // (11)

  // Накопительные ряды для графика
  const cumPlanSeries = [], cumFactSeries = [], dailyPlanSeries = [];
  let accFact = 0;
  for (let i = 0; i < dim; i++) {
    dailyPlanSeries.push(dailyPlan);
    cumPlanSeries.push(dailyPlan * (i + 1));
    if (i < curDay) { accFact += days[i][M.field]; cumFactSeries.push(accFact); }
    else cumFactSeries.push(null);
  }
  // Линия прогноза: от последней точки факта до прогноза в конце месяца
  const forecastSeries = new Array(dim).fill(null);
  if (curDay > 0 && curDay < dim) {
    forecastSeries[curDay - 1] = actualCum;
    forecastSeries[dim - 1] = forecast;
  }

  return {
    M, dim, curDay, monthlyPlan, dailyPlan, cumPlanToday, actualCum,
    planCompletion, monthCompletion, dailyAvgActual, forecast, forecastGap,
    deviationRub, deviationPct, catchUp, remainingDays, requiredRunRate,
    avgOrderValue, avgBuyoutValue, buyoutRate, drr, cum, days,
    cumPlanSeries, cumFactSeries, dailyPlanSeries, forecastSeries,
  };
}

/* Период день1..curDay для произвольного месяца (для сравнения МоМ) */
function periodSum(monthKey, channel, curDay, field) {
  const { days } = aggregateByDay(monthKey, channel);
  return sumField(days, field, curDay);
}

/* ============================================================
   Рендер
   ============================================================ */
function el(id) { return document.getElementById(id); }

function render() {
  const c = compute(state.month, state.channel, state.metric);
  renderVerdict(c);
  renderKPIs(c);
  renderProgress(c);
  renderBlocks(c);
  renderCosts(c);
  renderCompare(c);
  renderTable(c);
  renderCumulativeChart(c);
  renderChannelChart(c);
  syncToday();
  renderPlanEditor();
}

function scopeLabel() {
  const ch = state.channel === 'all' ? 'все каналы' : state.channel;
  return `· ${state.month} · ${ch} · ${METRICS[state.metric].label.toLowerCase()}`;
}

function renderVerdict(c) {
  const v = el('verdict');
  const ahead = c.deviationRub >= 0;
  v.classList.toggle('verdict--ahead', ahead);
  v.classList.toggle('verdict--behind', !ahead);
  el('verdict-arrow').textContent = ahead ? '↑' : '↓';
  el('verdict-status').textContent = ahead ? 'Иду в план' : 'Отстаю от плана';

  const detail = ahead
    ? `Факт выше плана на ${fmtSignedPct(c.deviationPct).replace('+', '')} — опережение ${fmtMoney(Math.abs(c.deviationRub))} к ${c.curDay}-му числу.`
    : `Факт ниже плана на ${Math.abs(c.deviationPct).toFixed(1)}% — отставание ${fmtMoney(Math.abs(c.deviationRub))} к ${c.curDay}-му числу.`;
  el('verdict-detail').textContent = detail;

  el('v-completion').textContent = fmtPct(c.planCompletion);
  el('v-completion').className = 'vnum__value ' + (ahead ? 'pos' : 'neg');
  el('v-catchup').textContent = c.catchUp > 0 ? fmtMoney(c.catchUp) : '0 ₽ — в плане';
  el('v-runrate').textContent = fmtMoney(c.requiredRunRate) + '/день';
}

function kpiCard(label, value, foot, opts = {}) {
  const cls = ['kpi']; if (opts.hero) cls.push('kpi--hero');
  const valCls = 'kpi__value' + (opts.tone ? ' ' + opts.tone : '');
  return `<div class="${cls.join(' ')}">
    <div class="kpi__label">${label}</div>
    <div class="${valCls}">${value}</div>
    <div class="kpi__foot">${foot || ''}</div>
  </div>`;
}

function renderKPIs(c) {
  el('kpi-scope').textContent = scopeLabel();
  const money = c.M.money;
  const ahead = c.deviationRub >= 0;
  const fc = c.forecastGap >= 0;

  const cards = [
    kpiCard('Выполнение плана', fmtPct(c.planCompletion),
      `Факт ${fmtVal(c.actualCum, money)} из ${fmtVal(c.cumPlanToday, money)} к ${c.curDay}-му`,
      { hero: true }),
    kpiCard('План месяца', fmtVal(c.monthlyPlan, money), `${c.dim} дн · ${fmtVal(c.dailyPlan, money)}/день`),
    kpiCard('Факт месяца (накопит.)', fmtVal(c.actualCum, money), `Прошло ${c.curDay} из ${c.dim} дней`),
    kpiCard('План на сегодня (накопит.)', fmtVal(c.cumPlanToday, money), `${fmtVal(c.dailyPlan, money)} × ${c.curDay}`),
    kpiCard('Факт на сегодня (накопит.)', fmtVal(c.actualCum, money), `Средний темп ${fmtVal(c.dailyAvgActual, money)}/день`),
    kpiCard('Отклонение ₽', fmtSigned(c.deviationRub, money), 'Факт − план к сегодня',
      { tone: ahead ? 'pos' : 'neg' }),
    kpiCard('Отклонение %', fmtSignedPct(c.deviationPct), 'Относительно плана к сегодня',
      { tone: ahead ? 'pos' : 'neg' }),
    kpiCard('Прогноз на конец месяца', fmtVal(c.forecast, money),
      `${fc ? 'Перевыполнение' : 'Недовыполнение'} ${fmtMoney(Math.abs(c.forecastGap))}`,
      { tone: fc ? 'pos' : 'neg' }),
    kpiCard('Заказы', fmtNum(c.cum.orders_count) + ' шт', `Средний чек ${fmtMoney(c.avgOrderValue)}`),
    kpiCard('Выкупы', fmtNum(c.cum.buyouts_count) + ' шт', `Buyout rate ${c.buyoutRate.toFixed(1)}%`),
    kpiCard('Средний чек', fmtMoney(c.avgOrderValue), `Чек выкупа ${fmtMoney(c.avgBuyoutValue)}`),
    kpiCard('ДРР', c.drr.toFixed(1) + '%', `Реклама ${fmtMoney(c.cum.ad_spend)}`),
    kpiCard('Чистая выручка', fmtMoney(c.cum.net_revenue),
      `После рекламы, логистики и комиссий`),
  ];
  el('kpi-grid').innerHTML = cards.join('');
}

function renderProgress(c) {
  const money = c.M.money;
  el('progress-sub').textContent = `Факт ${fmtVal(c.actualCum, money)} из ${fmtVal(c.monthlyPlan, money)} · прогноз ${fmtVal(c.forecast, money)}`;
  el('progress-pct').textContent = fmtPct(c.monthCompletion, 0);
  el('progress-pct').className = 'progress-pct ' + (c.monthCompletion >= (c.curDay / c.dim * 100) ? 'pos' : 'neg');
  el('bar-fill').style.width = Math.min(100, c.monthCompletion) + '%';
  el('bar-plan').style.left = Math.min(100, c.curDay / c.dim * 100) + '%';
}

function statRow(label, value, tone) {
  const t = tone ? ` ${tone}` : '';
  return `<div class="stat"><span class="stat__label">${label}</span><span class="stat__value${t}">${value}</span></div>`;
}

function renderBlocks(c) {
  const money = c.M.money;
  const { y, m } = parseMonthKey(state.month);

  // --- Сегодня ---
  const todayIdx = c.curDay - 1;
  const todayFact = c.curDay > 0 ? c.days[todayIdx][c.M.field] : 0;
  const todayDev = todayFact - c.dailyPlan;
  el('today-date').textContent = c.curDay > 0 ? `${c.curDay} ${MONTH_GEN[m - 1]}` : '—';
  el('block-today').querySelector('.block__body').innerHTML =
    statRow('План на день', fmtVal(c.dailyPlan, money)) +
    statRow('Факт за день', fmtVal(todayFact, money)) +
    statRow('Отклонение', fmtSigned(todayDev, money), todayDev >= 0 ? 'pos' : 'neg') +
    statRow('Заказов сегодня', fmtNum(c.days[Math.max(0, todayIdx)]?.orders_count || 0) + ' шт');

  // --- Неделя (Пн–Вс, в которую попадает текущий день) ---
  const w = weekWindow(y, m, c.curDay, c.dim);
  const weekPlan = c.dailyPlan * w.days;
  const weekFactToDate = sumRange(c.days, c.M.field, w.start, Math.min(w.endToDate, c.curDay));
  const weekPlanToDate = c.dailyPlan * Math.max(0, Math.min(w.endToDate, c.curDay) - w.start + 1);
  const weekDev = weekFactToDate - weekPlanToDate;
  el('week-range').textContent = `${w.start}–${w.end} ${MONTH_GEN[m - 1]}`;
  el('block-week').querySelector('.block__body').innerHTML =
    statRow('План недели (полной)', fmtVal(weekPlan, money)) +
    statRow('План к текущему дню', fmtVal(weekPlanToDate, money)) +
    statRow('Факт недели', fmtVal(weekFactToDate, money)) +
    statRow('Отклонение', fmtSigned(weekDev, money), weekDev >= 0 ? 'pos' : 'neg');

  // --- Месяц ---
  el('month-name').textContent = `${MONTH_NAMES[m - 1]} ${y}`;
  el('block-month').querySelector('.block__body').innerHTML =
    statRow('План месяца', fmtVal(c.monthlyPlan, money)) +
    statRow('Факт (накопит.)', fmtVal(c.actualCum, money)) +
    statRow('Выполнение', fmtPct(c.monthCompletion), c.deviationRub >= 0 ? 'pos' : 'neg') +
    statRow('Прогноз', fmtVal(c.forecast, money), c.forecastGap >= 0 ? 'pos' : 'neg');
}

// окно недели Пн–Вс внутри месяца
function weekWindow(y, m, curDay, dim) {
  const day = Math.max(1, curDay);
  const dow = (new Date(y, m - 1, day).getDay() + 6) % 7; // 0=Пн
  const start = Math.max(1, day - dow);
  const end = Math.min(dim, start + 6);
  return { start, end, days: end - start + 1, endToDate: end };
}
function sumRange(days, field, from1, to1) {
  let s = 0;
  for (let i = from1 - 1; i <= to1 - 1 && i < days.length; i++) if (i >= 0) s += days[i][field];
  return s;
}

/* --- Структура расходов и прибыли (за период 1..curDay) --- */
function renderCosts(c) {
  const rb = c.cum.revenue_buyouts || 0;
  const net = c.cum.net_revenue || 0;
  const pct = v => rb > 0 ? (v / rb * 100).toFixed(1) + '%' : '—';
  const line = (label, val, share, tone) =>
    `<div class="stat"><span class="stat__label">${label}</span>` +
    `<span class="stat__value${tone ? ' ' + tone : ''}">${fmtMoney(val)} ` +
    `<span class="muted-inline">${share}</span></span></div>`;

  el('cost-sub').textContent =
    `За период 1–${c.curDay} · ${state.channel === 'all' ? 'все каналы' : state.channel}`;
  el('cost-body').innerHTML =
    line('Выручка по выкупам', rb, '100%') +
    line('− Реклама (ДРР)', c.cum.ad_spend, pct(c.cum.ad_spend), 'neg') +
    line('− Логистика', c.cum.logistics, pct(c.cum.logistics), 'neg') +
    line('− Комиссии маркетплейсов', c.cum.commissions, pct(c.cum.commissions), 'neg') +
    line('− Штрафы', c.cum.penalties, pct(c.cum.penalties), 'neg') +
    line('− Прочие расходы', c.cum.other_costs, pct(c.cum.other_costs), 'neg') +
    line('= Чистая выручка', net, 'маржа ' + (rb > 0 ? (net / rb * 100).toFixed(1) : '0') + '%',
         net >= 0 ? 'pos' : 'neg');
}

/* --- Сравнение месяц к месяцу (день 1..curDay этого vs прошлого месяца) --- */
function renderCompare(c) {
  const prev = prevMonthKey(state.month);
  el('compare-scope').textContent = `· ${state.month} vs ${prev}`;
  const ch = state.channel;

  const hasPrev = state.db.data.some(r => r.date.startsWith(prev));
  if (!hasPrev) {
    el('compare-sub').textContent = `Нет данных за ${prev} для сравнения.`;
    el('compare-grid').innerHTML = '';
    return;
  }
  el('compare-sub').textContent = `Дни 1–${c.curDay} ${parseMonthKey(state.month).y} vs дни 1–${c.curDay} прошлого месяца.`;

  const items = [
    { key: 'orders_count', label: 'Заказы', money: false },
    { key: 'buyouts_count', label: 'Выкупы', money: false },
    { key: 'revenue_buyouts', label: 'Выручка (выкупы)', money: true },
    { key: 'net_revenue', label: 'Чистая выручка', money: true },
  ];
  el('compare-grid').innerHTML = items.map(it => {
    const now = periodSum(state.month, ch, c.curDay, it.key);
    const was = periodSum(prev, ch, c.curDay, it.key);
    const delta = now - was;
    const pct = was > 0 ? delta / was * 100 : 0;
    const up = delta >= 0;
    return `<div class="cmp">
      <div class="cmp__label">${it.label}</div>
      <div class="cmp__now">${fmtVal(now, it.money)}</div>
      <div class="cmp__prev">прошлый месяц: ${fmtVal(was, it.money)}</div>
      <div class="cmp__delta ${up ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${fmtSigned(delta, it.money)} (${fmtSignedPct(pct)})</div>
    </div>`;
  }).join('');
}

/* --- Таблица по дням --- */
function renderTable(c) {
  const money = c.M.money;
  const tbody = el('day-table').querySelector('tbody');
  const { m } = parseMonthKey(state.month);
  let cumPlan = 0, cumFact = 0, rows = '';
  for (let i = 0; i < c.dim; i++) {
    const dayNo = i + 1;
    cumPlan += c.dailyPlan;
    const isPast = dayNo <= c.curDay;
    const dailyFact = isPast ? c.days[i][c.M.field] : null;
    if (isPast) cumFact += c.days[i][c.M.field];
    const dev = isPast ? (cumFact - cumPlan) : null;
    const pct = isPast && cumPlan > 0 ? cumFact / cumPlan * 100 : null;

    let rowCls = 'future', statusHtml = '<span class="tag-status s-future">впереди</span>';
    if (isPast) {
      const ahead = dev >= 0;
      rowCls = ahead ? 'ahead' : 'behind';
      statusHtml = `<span class="tag-status ${ahead ? 's-ahead' : 's-behind'}">${ahead ? '↑ в плане' : '↓ отставание'}</span>`;
    }
    if (dayNo === c.curDay) rowCls += ' is-today';

    rows += `<tr class="${rowCls}">
      <td>${dayNo}</td>
      <td class="num">${money ? fmtNum(c.dailyPlan) : c.dailyPlan.toFixed(0)}</td>
      <td class="num">${isPast ? fmtNum(dailyFact) : '—'}</td>
      <td class="num">${fmtNum(cumPlan)}</td>
      <td class="num">${isPast ? fmtNum(cumFact) : '—'}</td>
      <td class="num ${isPast ? (dev >= 0 ? 'pos' : 'neg') : ''}">${isPast ? fmtSigned(dev, false) : '—'}</td>
      <td class="num">${isPast ? pct.toFixed(0) + '%' : '—'}</td>
      <td>${statusHtml}</td>
    </tr>`;
  }
  tbody.innerHTML = rows;
}

/* ============================================================
   Графики (Chart.js)
   ============================================================ */
const CSSV = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function renderCumulativeChart(c) {
  const ctx = el('chart-cumulative').getContext('2d');
  const labels = Array.from({ length: c.dim }, (_, i) => i + 1);
  const money = c.M.money;
  el('chart1-sub').textContent = `${state.month} · ${state.channel === 'all' ? 'все каналы' : state.channel} · ${c.M.label.toLowerCase()}`;

  if (charts.cumulative) charts.cumulative.destroy();
  charts.cumulative = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'План накопит.', data: c.cumPlanSeries, borderColor: CSSV('--faint'), borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, tension: 0, fill: false },
        { label: 'Факт накопит.', data: c.cumFactSeries, borderColor: CSSV('--brand'), backgroundColor: 'rgba(15,169,104,.10)', borderWidth: 2.5, pointRadius: 0, tension: .15, fill: true, spanGaps: false },
        { label: 'Прогноз', data: c.forecastSeries, borderColor: CSSV('--brand-l'), borderDash: [3, 3], borderWidth: 1.5, pointRadius: 0, tension: 0, fill: false, spanGaps: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, color: CSSV('--muted'), font: { family: 'Inter' } } },
        tooltip: {
          callbacks: {
            title: (it) => `День ${it[0].label}`,
            label: (it) => `${it.dataset.label}: ${it.parsed.y == null ? '—' : (money ? fmtMoney(it.parsed.y) : fmtNum(it.parsed.y) + ' шт')}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: CSSV('--faint'), maxRotation: 0, autoSkipPadding: 14 } },
        y: { grid: { color: CSSV('--line') }, ticks: { color: CSSV('--faint'), callback: (v) => money ? compactRub(v) : fmtNum(v) } },
      },
    },
  });
}

function compactRub(v) {
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace('.0', '') + ' млн';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + ' тыс';
  return fmtNum(v);
}

function renderChannelChart(c) {
  const ctx = el('chart-channels').getContext('2d');
  const field = c.M.field, money = c.M.money;
  const prev = prevMonthKey(state.month);
  const channels = state.db.meta.channels;

  const now = channels.map(ch => periodSum(state.month, ch, c.curDay, field));
  const was = channels.map(ch => periodSum(prev, ch, c.curDay, field));
  // подсветка проседающих каналов (факт ниже прошлого месяца)
  const colors = channels.map((_, i) => (now[i] < was[i] ? CSSV('--neg') : CSSV('--brand')));

  if (charts.channels) charts.channels.destroy();
  charts.channels = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: channels,
      datasets: [
        { label: 'Текущий период', data: now, backgroundColor: colors, borderRadius: 5, barPercentage: .9, categoryPercentage: .65 },
        { label: 'Прошлый месяц', data: was, backgroundColor: CSSV('--line'), borderRadius: 5, barPercentage: .9, categoryPercentage: .65 },
      ],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 12, color: CSSV('--muted'), font: { family: 'Inter' } } },
        tooltip: {
          callbacks: {
            label: (it) => {
              const i = it.dataIndex, delta = now[i] - was[i];
              const base = `${it.dataset.label}: ${money ? fmtMoney(it.parsed.x) : fmtNum(it.parsed.x) + ' шт'}`;
              if (it.datasetIndex === 0) return [base, `Δ к прошлому: ${fmtSigned(delta, money)}`];
              return base;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: CSSV('--line') }, ticks: { color: CSSV('--faint'), callback: (v) => money ? compactRub(v) : fmtNum(v) } },
        y: { grid: { display: false }, ticks: { color: CSSV('--ink'), font: { family: 'Inter', weight: '500' } } },
      },
    },
  });
}

/* ============================================================
   Фильтры и инициализация
   ============================================================ */
function todayISO() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function formatRu(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTH_GEN[m - 1]} ${y}`;
}
// Диапазон дат, на которые есть данные (для ограничения календаря)
function dataDateRange() {
  const ds = state.db.data.map(r => r.date).sort();
  return { min: ds[0], max: ds[ds.length - 1] };
}
// Синхронизировать поле-календарь с выбранной датой
function syncToday() {
  const inp = el('today-input');
  if (inp) inp.value = state.today;
  const lab = el('today-human');
  if (lab) lab.textContent = formatRu(state.today);
}

/* ---- Планы: ручное редактирование + сохранение в браузере ----
   Правки применяются сразу. localStorage работает в скачанном файле и на
   хостинге; в предпросмотре чата может быть недоступен — тогда правки
   действуют до перезагрузки (обёрнуто в try/catch). ---- */
const PLAN_KEY = 'bioboro_plan_overrides_v1';
function loadPlanOverrides() {
  try { return JSON.parse(localStorage.getItem(PLAN_KEY)) || {}; } catch (e) { return {}; }
}
function savePlanOverrides(obj) {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(obj)); } catch (e) { /* нет доступа — ок */ }
}
function applyPlanOverrides() {
  const ov = loadPlanOverrides();
  for (const mk of Object.keys(ov)) {
    state.db.plans[mk] = Object.assign({}, state.db.plans[mk] || {}, ov[mk]);
  }
}
function setPlanValue(monthKey, metricKey, value) {
  if (!state.db.plans[monthKey]) state.db.plans[monthKey] = {};
  state.db.plans[monthKey][metricKey] = value;
  const ov = loadPlanOverrides();
  ov[monthKey] = Object.assign({}, ov[monthKey], { [metricKey]: value });
  savePlanOverrides(ov);
}

// Порядок и подписи метрик в редакторе плана (деньги — сверху, чистая выручка выделена)
const PLAN_ORDER = [
  ['net_revenue', 'Чистая выручка', '₽', true],
  ['revenue_buyouts', 'Выручка (выкупы)', '₽', false],
  ['revenue_orders', 'Выручка (заказы)', '₽', false],
  ['orders_count', 'Заказы', 'шт', false],
  ['buyouts_count', 'Выкупы', 'шт', false],
];

function renderPlanEditor() {
  const host = el('plan-cells');
  if (!host) return;
  const plans = state.db.plans[state.month] || {};
  el('plan-month').textContent = monthTitle(state.month);
  host.innerHTML = PLAN_ORDER.map(([key, label, unit, hero]) => `
    <label class="plan-cell${hero ? ' plan-cell--hero' : ''}">
      <span class="plan-cell__label">${label}<span class="plan-cell__unit">${unit}</span></span>
      <input class="plan-input" type="number" inputmode="numeric" min="0" step="1000"
             data-metric="${key}" value="${plans[key] != null ? plans[key] : ''}"
             placeholder="0">
    </label>`).join('');

  host.querySelectorAll('.plan-input').forEach(inp => {
    inp.addEventListener('change', e => {
      const v = Math.max(0, Math.round(Number(e.target.value) || 0));
      e.target.value = v;
      setPlanValue(state.month, e.target.dataset.metric, v);
      render();
    });
  });
}

function monthTitle(mk) { const { y, m } = parseMonthKey(mk); return `${MONTH_NAMES[m - 1]} ${y}`; }

function buildFilters() {
  const months = Object.keys(state.db.plans).sort().reverse();
  const fm = el('f-month');
  fm.innerHTML = months.map(mk => {
    const { y, m } = parseMonthKey(mk);
    return `<option value="${mk}">${MONTH_NAMES[m - 1]} ${y}</option>`;
  }).join('');
  fm.value = state.month;

  const fc = el('f-channel');
  fc.innerHTML = `<option value="all">Все каналы</option>` +
    state.db.meta.channels.map(ch => `<option value="${ch}">${ch}</option>`).join('');
  fc.value = state.channel;

  const fme = el('f-metric');
  fme.innerHTML = Object.entries(METRICS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  fme.value = state.metric;

  fm.addEventListener('change', e => { state.month = e.target.value; render(); });
  fc.addEventListener('change', e => { state.channel = e.target.value; render(); });
  fme.addEventListener('change', e => { state.metric = e.target.value; render(); });

  // Календарь: выбор «точки отсчёта» (что считать «сегодня»)
  const di = el('today-input');
  if (di) {
    const { min, max } = dataDateRange();
    di.min = min; di.max = max; di.value = state.today;
    di.addEventListener('change', e => {
      let v = e.target.value || state.today;
      if (v < min) v = min; if (v > max) v = max;
      state.today = v;
      const mk = v.slice(0, 7);
      if (months.includes(mk)) { state.month = mk; fm.value = mk; }  // показать месяц выбранной даты
      render();
    });
  }

  // Сброс ручных правок плана к значениям из data.json
  const pr = el('plan-reset');
  if (pr) pr.addEventListener('click', () => {
    try { localStorage.removeItem(PLAN_KEY); } catch (e) {}
    state.db = null;            // перезагрузим исходные планы
    init();
  });
}

/* ============================================================
   Источник данных — переключаемый.
   SOURCE.type: 'json' | 'github' | 'gsheets'
     'json'    — локальный data.json рядом с index.html (по умолчанию)
     'github'  — raw-ссылка на data.json в репозитории GitHub
     'gsheets' — опубликованный из Google Sheets CSV (лист с дневными строками;
                 meta/plans берутся из DEFAULT_CONFIG ниже)
   Подробности и примеры — в README.md.
   ============================================================ */
const SOURCE = {
  type: 'json',
  jsonUrl: 'data.json',
  githubRawUrl: 'https://raw.githubusercontent.com/USER/REPO/main/data.json',
  gsheetsCsvUrl: 'https://docs.google.com/spreadsheets/d/SHEET_ID/export?format=csv&gid=0',
};

// Конфиг (meta + plans) для источника gsheets, где лист содержит только дневные строки.
const DEFAULT_CONFIG = {
  meta: {
    business: 'BIOBORO', currency: 'RUB', default_month: '2026-06',
    default_metric: 'revenue_buyouts',
    channels: ['Wildberries', 'Ozon', 'Site', 'Clinics', 'VK', 'YouTube'],
  },
  plans: {
    '2026-06': { revenue_buyouts: 10000000, revenue_orders: 12500000, orders_count: 7353, buyouts_count: 5882, net_revenue: 4200000 },
    '2026-05': { revenue_buyouts: 9000000,  revenue_orders: 11250000, orders_count: 6618, buyouts_count: 5294, net_revenue: 3780000 },
  },
};

const CSV_NUMERIC = ['revenue_orders','revenue_buyouts','orders_count','buyouts_count','ad_spend','logistics','commissions','penalties','other_costs','net_revenue','margin'];

// Простой CSV-парсер (поддерживает кавычки и запятые внутри значений)
function parseCsv(text) {
  const rows = []; let row = [], val = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { val += '"'; i++; }
      else if (ch === '"') q = false;
      else val += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(val); val = ''; }
    else if (ch === '\n') { row.push(val); rows.push(row); row = []; val = ''; }
    else if (ch === '\r') { /* skip */ }
    else val += ch;
  }
  if (val.length || row.length) { row.push(val); rows.push(row); }
  return rows.filter(r => r.length && r.some(c => c.trim() !== ''));
}

// CSV -> { meta, plans, data } по схеме дашборда (meta/plans берём из DEFAULT_CONFIG)
function csvToDataset(text) {
  const rows = parseCsv(text);
  const header = rows.shift().map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const data = rows.map(r => {
    const o = { date: (r[idx.date] || '').trim(), channel: (r[idx.channel] || '').trim() };
    for (const f of CSV_NUMERIC) o[f] = Number((r[idx[f]] ?? '0').toString().replace(/\s/g, '').replace(',', '.')) || 0;
    return o;
  }).filter(o => o.date && o.channel);
  return { meta: DEFAULT_CONFIG.meta, plans: DEFAULT_CONFIG.plans, data };
}

async function loadData() {
  // 0) встроенные данные (предпросмотр одним файлом) — имеют приоритет
  if (window.BIOBORO_DATA) return window.BIOBORO_DATA;
  // 1) Google Sheets (CSV)
  if (SOURCE.type === 'gsheets') {
    const res = await fetch(SOURCE.gsheetsCsvUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return csvToDataset(await res.text());
  }
  // 2) GitHub raw JSON или 3) локальный data.json
  const url = SOURCE.type === 'github' ? SOURCE.githubRawUrl : SOURCE.jsonUrl;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function init() {
  try {
    state.db = await loadData();
    applyPlanOverrides();   // ручные правки плана из браузера поверх data.json
    state.month = state.db.meta.default_month || Object.keys(state.db.plans).sort().reverse()[0];
    state.metric = state.db.meta.default_metric || 'revenue_buyouts';
    // «Сегодня» по умолчанию: meta.today → meta.generated_at → системная дата,
    // но не выходя за пределы дат, на которые есть данные.
    const range = dataDateRange();
    let t = state.today || state.db.meta.today || state.db.meta.generated_at || todayISO();
    if (t < range.min) t = range.min; if (t > range.max) t = range.max;
    state.today = t;
    buildFilters();
    render();
  } catch (err) {
    document.querySelector('.app').insertAdjacentHTML('afterbegin',
      `<div class="card" style="border-color:var(--neg);color:var(--neg);margin-bottom:14px">
        Не удалось загрузить <code>data.json</code> (${String(err.message || err)}).
        Откройте проект через локальный сервер: <code>python3 -m http.server</code> и зайдите на
        <code>http://localhost:8000</code>. Браузеры блокируют чтение локальных файлов напрямую через file://.
      </div>`);
    console.error(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
