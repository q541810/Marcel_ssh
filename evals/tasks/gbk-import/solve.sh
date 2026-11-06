#!/bin/bash
python3 - <<'PY'
import csv, glob, os, sqlite3
c = sqlite3.connect("/opt/inventory/inventory.db")
c.execute("DELETE FROM items")
for path in sorted(glob.glob("/data/import/*.csv")):
    raw = open(path, "rb").read()
    for enc in ("utf-8-sig", "gbk"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            pass
    supplier = os.path.basename(path).rsplit(".", 1)[0]
    for row in csv.DictReader(text.splitlines()):
        c.execute("INSERT INTO items (sku, name, qty, price, supplier) VALUES (?, ?, ?, ?, ?)",
                  (row["sku"], row["name"], int(row["qty"]), float(row["price"]), supplier))
c.commit()
PY
