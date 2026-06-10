#!/usr/bin/env python3
"""
BIOBORO — генератор тестовых данных.
Создаёт реалистичные данные по дням и каналам за 2 месяца -> data.json
Запуск:  python3 generate_data.py
"""
import json, random, calendar, datetime

random.seed(20260610)  # детерминированно: один и тот же data.json при каждом запуске

CHANNELS = {
    # share — доля канала в выручке-выкупах; avg — средний чек выкупа; brate — buyout rate;
    # comm/logi/pen/oth — % комиссий/логистики/штрафов/прочих расходов; drr — целевой ДРР.
    "Wildberries": dict(share=0.45, avg=1550, brate=0.78, comm=0.18, logi=0.07, pen=0.012, oth=0.010, drr=0.15),
    "Ozon":        dict(share=0.20, avg=1620, brate=0.80, comm=0.16, logi=0.07, pen=0.010, oth=0.010, drr=0.14),
    "Site":        dict(share=0.15, avg=2100, brate=0.92, comm=0.03, logi=0.05, pen=0.001, oth=0.006, drr=0.11),
    "Clinics":     dict(share=0.12, avg=3800, brate=0.97, comm=0.02, logi=0.02, pen=0.000, oth=0.004, drr=0.05),
    "VK":          dict(share=0.05, avg=1900, brate=0.88, comm=0.03, logi=0.05, pen=0.003, oth=0.006, drr=0.19),
    "YouTube":     dict(share=0.03, avg=1750, brate=0.85, comm=0.03, logi=0.05, pen=0.003, oth=0.006, drr=0.17),
}

def weekday_factor(d):
    # лёгкая недельная сезонность (пн..вс)
    return [1.02, 1.04, 1.05, 1.03, 1.08, 0.95, 0.88][d.weekday()]

def month_rows(year, month, last_day, plan_buyouts, target_pace, channel_pace):
    dim = calendar.monthrange(year, month)[1]
    rows = []
    for day in range(1, last_day + 1):
        d = datetime.date(year, month, day)
        wf = weekday_factor(d)
        for ch, p in CHANNELS.items():
            daily = (plan_buyouts * p["share"]) / dim
            rev_buyouts = round(daily * wf * target_pace * channel_pace.get(ch, 1.0) * random.uniform(0.82, 1.18), -1)
            buyouts_count = max(1, round(rev_buyouts / p["avg"]))
            orders_count = max(buyouts_count, round(buyouts_count / p["brate"]))
            rev_orders = round(orders_count * p["avg"] * random.uniform(0.97, 1.03), -1)
            ad_spend = round(rev_orders * p["drr"] * random.uniform(0.9, 1.12), -1)
            logistics = round(rev_buyouts * p["logi"] * random.uniform(0.9, 1.1), -1)
            commissions = round(rev_buyouts * p["comm"] * random.uniform(0.97, 1.03), -1)
            # штрафы и прочие расходы — детерминированно (% от выручки по выкупам),
            # чтобы не сдвигать случайный поток остальных полей.
            penalties = round(rev_buyouts * p["pen"], -1)
            other_costs = round(rev_buyouts * p["oth"], -1)
            net = round(rev_buyouts - ad_spend - logistics - commissions - penalties - other_costs, -1)
            rows.append({
                "date": d.isoformat(), "channel": ch,
                "revenue_orders": int(rev_orders), "revenue_buyouts": int(rev_buyouts),
                "orders_count": int(orders_count), "buyouts_count": int(buyouts_count),
                "ad_spend": int(ad_spend), "logistics": int(logistics),
                "commissions": int(commissions), "penalties": int(penalties),
                "other_costs": int(other_costs), "net_revenue": int(net),
                "margin": round(net / rev_buyouts * 100, 1) if rev_buyouts else 0,
            })
    return rows

def plan_block(buyouts):
    return {
        "revenue_buyouts": buyouts,
        "revenue_orders": round(buyouts / 0.80),
        "orders_count": round(buyouts / 1700 / 0.80),
        "buyouts_count": round(buyouts / 1700),
        "net_revenue": round(buyouts * 0.42),
    }

# Май — завершённый месяц, шёл чуть выше своего (меньшего) плана.
may = month_rows(2026, 5, 31, 9_000_000, target_pace=1.04,
                 channel_pace={"Wildberries":1.03,"Ozon":1.05,"Site":1.10,"Clinics":1.0,"VK":1.12,"YouTube":1.08})
# Июнь — текущий месяц, факт по 10-е число, идём с отставанием; VK и YouTube проседают.
jun = month_rows(2026, 6, 10, 10_000_000, target_pace=0.93,
                 channel_pace={"Wildberries":0.98,"Ozon":1.02,"Site":0.90,"Clinics":1.05,"VK":0.62,"YouTube":0.70})

dataset = {
    "meta": {
        "business": "BIOBORO", "currency": "RUB",
        "generated_at": "2026-06-10",
        "default_month": "2026-06", "default_metric": "revenue_buyouts",
        "channels": list(CHANNELS.keys()),
    },
    "plans": {"2026-05": plan_block(9_000_000), "2026-06": plan_block(10_000_000)},
    "data": may + jun,
}

with open("data.json", "w", encoding="utf-8") as f:
    json.dump(dataset, f, ensure_ascii=False, indent=2)

for mk in ("2026-05", "2026-06"):
    rb = sum(r["revenue_buyouts"] for r in dataset["data"] if r["date"].startswith(mk))
    print(mk, "выкупы-факт:", f"{rb:,}", "план:", f"{dataset['plans'][mk]['revenue_buyouts']:,}")
print("строк всего:", len(dataset["data"]))
