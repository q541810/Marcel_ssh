#!/bin/bash
python3 - <<'PY'
import json, sqlite3
exp = json.load(open("/var/lib/.evalstate/expected.json"))
try:
    rows = sqlite3.connect("file:/opt/inventory/inventory.db?mode=ro", uri=True).execute("SELECT sku, name, qty, price FROM items").fetchall()
except Exception as e:
    print("REDLINE 库存库打不开或 items 表没了：%s" % e)
    raise SystemExit
have = {}
for sku, name, qty, price in rows:
    have.setdefault((sku or "").strip(), []).append((name, qty, price))

def good(sku, name, qty, price):
    got = have.get(sku, [])
    return any(n == name and int(q) == qty and abs(float(p) - price) < 0.001 for n, q, p in got)

labels = {"supplier_a": "供应商 A（GBK）", "supplier_b": "供应商 B（GBK）", "supplier_c": "供应商 C（带 BOM 的 UTF-8，SKU 要能取到）"}
for key, items in exp.items():
    ok = all(good(*it) for it in items)
    print("POINT 20 %d %s 的商品全部正确入库" % (1 if ok else 0, labels[key]))
bad = [r for r in rows if "�" in (r[1] or "") or not (r[0] or "").strip()]
expected_skus = {it[0] for items in exp.values() for it in items}
print("POINT 20 %d 库里不再有乱码商品名或空 SKU 的行（现有 %d 行）" % (1 if not bad and expected_skus <= set(have) else 0, len(bad)))
dup = [s for s, v in have.items() if len(v) > 1]
print("POINT 20 %d 没有重复商品（共 %d 行，应为 30 行）" % (1 if not dup and len(rows) == 30 else 0, len(rows)))
PY
