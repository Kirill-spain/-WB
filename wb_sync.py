#!/usr/bin/env python3
"""
BIOBORO · Синхронизация Wildberries → data.json

Тянет заказы и продажи/возвраты из WB Statistics API, агрегирует по дням
для канала "Wildberries" и вписывает их в data.json (остальные каналы и
блок plans не трогаются). Запускается из GitHub Actions по расписанию.

Токен (тип «Статистика») берётся из переменной окружения WB_STATS_TOKEN.
Зависимостей нет — только стандартная библиотека Python.

Поля, которые получаем из API:
  revenue_orders   — сумма priceWithDisc по заказам (без отменённых)
  orders_count     — число заказов (без отменённых)
  revenue_buyouts  — сумма priceWithDisc по выкупам (продажи "S" минус возвраты "R")
  buyouts_count    — число выкупов (S) за вычетом возвратов (R)
  commissions      — комиссия WB ≈ priceWithDisc − forPay по выкупам
  net_revenue      — revenue_buyouts − все расходы (здесь = − commissions)
Поля ad_spend / logistics / penalties / other_costs ставятся в 0 — их при
желании можно дозаполнять из финансового отчёта (/api/v5/supplier/reportDetailByPeriod)
или вручную; формулы дашборда подхватят значения автоматически.
"""

import os
import sys
import json
import time
import datetime as dt
import urllib.parse
import urllib.request
import urllib.error

BASE = "https://statistics-api.wildberries.ru"
ORDERS_PATH = "/api/v1/supplier/orders"
SALES_PATH = "/api/v1/supplier/sales"
CHANNEL = "Wildberries"
DATA_FILE = os.environ.get("BIOBORO_DATA_FILE", "data.json")
TOKEN = os.environ.get("WB_STATS_TOKEN", "").strip()

# WB ограничивает статистические эндпоинты примерно 1 запросом в минуту.
REQUEST_INTERVAL = float(os.environ.get("WB_REQUEST_INTERVAL", "65"))
NUMERIC = ["revenue_orders", "revenue_buyouts", "orders_count", "buyouts_count",
           "ad_spend", "logistics", "commissions", "penalties", "other_costs"]


def http_get(path, date_from):
    qs = urllib.parse.urlencode({"dateFrom": date_from, "flag": 0})
    req = urllib.request.Request(f"{BASE}{path}?{qs}",
                                 headers={"Authorization": TOKEN,
                                          "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8") or "[]")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")[:300]
        raise SystemExit(f"WB API {path} → HTTP {e.code}: {body}")
    except urllib.error.URLError as e:
        raise SystemExit(f"WB API {path} → сетевая ошибка: {e.reason}")


def fetch_all(path, start_iso):
    """Постранично тянем по lastChangeDate, пока приходят данные."""
    out, cursor, seen = [], start_iso, set()
    while True:
        batch = http_get(path, cursor)
        if not batch:
            break
        out.extend(batch)
        last = max((r.get("lastChangeDate") or "" for r in batch), default="")
        # защита от зацикливания: если курсор не сдвинулся — выходим
        if not last or last == cursor or last in seen:
            break
        seen.add(cursor)
        cursor = last
        if len(batch) < 80000:      # меньше лимита страницы → данные кончились
            break
        time.sleep(REQUEST_INTERVAL)
    return out


def blank_day(date_str):
    row = {"date": date_str, "channel": CHANNEL}
    for k in NUMERIC:
        row[k] = 0
    return row


def aggregate(orders, sales, window_start, window_end):
    """orders/sales (сырые записи WB) → {date: row} по каналу WB."""
    days = {}
    d = window_start
    while d <= window_end:
        days[d.isoformat()] = blank_day(d.isoformat())
        d += dt.timedelta(days=1)

    for o in orders:
        day = (o.get("date") or "")[:10]
        if day not in days:
            continue
        if o.get("isCancel"):
            continue
        days[day]["orders_count"] += 1
        days[day]["revenue_orders"] += float(o.get("priceWithDisc") or 0)

    # выкупы (saleID "S...") и возвраты ("R...")
    for s in sales:
        day = (s.get("date") or "")[:10]
        if day not in days:
            continue
        sale_id = str(s.get("saleID") or "")
        price = float(s.get("priceWithDisc") or 0)
        forpay = float(s.get("forPay") or 0)
        if sale_id.startswith("S"):
            days[day]["buyouts_count"] += 1
            days[day]["revenue_buyouts"] += price
            days[day]["commissions"] += max(price - forpay, 0)
        elif sale_id.startswith("R"):
            days[day]["buyouts_count"] -= 1
            days[day]["revenue_buyouts"] -= price
            days[day]["commissions"] -= max(price - forpay, 0)

    rows = []
    for date_str in sorted(days):
        r = days[date_str]
        for k in NUMERIC:
            r[k] = int(round(r[k]))
        rb = r["revenue_buyouts"]
        r["net_revenue"] = rb - r["ad_spend"] - r["logistics"] - r["commissions"] \
            - r["penalties"] - r["other_costs"]
        r["margin"] = round(r["net_revenue"] / rb * 100, 1) if rb else 0
        rows.append(r)
    return rows


def load_dataset():
    if not os.path.exists(DATA_FILE):
        return {"meta": {"business": "BIOBORO", "currency": "RUB",
                         "default_month": dt.date.today().strftime("%Y-%m"),
                         "default_metric": "revenue_buyouts",
                         "channels": [CHANNEL]},
                "plans": {}, "data": []}
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def merge(dataset, new_rows, window_start, window_end):
    ws, we = window_start.isoformat(), window_end.isoformat()
    kept = [r for r in dataset.get("data", [])
            if not (r.get("channel") == CHANNEL and ws <= r.get("date", "") <= we)]
    dataset["data"] = kept + new_rows
    dataset["data"].sort(key=lambda r: (r.get("date", ""), r.get("channel", "")))
    meta = dataset.setdefault("meta", {})
    chans = meta.setdefault("channels", [])
    if CHANNEL not in chans:
        chans.append(CHANNEL)
    meta["last_wb_sync"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    return dataset


def main():
    if not TOKEN:
        raise SystemExit("Не задан WB_STATS_TOKEN (добавьте секрет в настройках репозитория).")

    today = dt.date.today()
    first_this = today.replace(day=1)
    window_start = (first_this - dt.timedelta(days=1)).replace(day=1)  # 1-е число прошлого месяца
    window_end = today
    start_iso = f"{window_start.isoformat()}T00:00:00"

    print(f"Окно синхронизации: {window_start} … {window_end}")
    orders = fetch_all(ORDERS_PATH, start_iso)
    print(f"Заказов получено: {len(orders)}")
    time.sleep(REQUEST_INTERVAL)
    sales = fetch_all(SALES_PATH, start_iso)
    print(f"Продаж/возвратов получено: {len(sales)}")

    rows = aggregate(orders, sales, window_start, window_end)
    dataset = load_dataset()
    merge(dataset, rows, window_start, window_end)

    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, indent=2)

    total_b = sum(r["revenue_buyouts"] for r in rows)
    total_o = sum(r["revenue_orders"] for r in rows)
    print(f"Записано строк WB: {len(rows)} | выручка-выкупы: {total_b:,} ₽ | "
          f"выручка-заказы: {total_o:,} ₽")


if __name__ == "__main__":
    main()
