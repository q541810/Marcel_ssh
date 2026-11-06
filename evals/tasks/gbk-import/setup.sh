#!/bin/bash
# 三个供应商 CSV：a、b 是 GBK 编码，c 是带 BOM 的 UTF-8。
# import.py 一律按 UTF-8 读、坏字节替换成 �，于是 a、b 的商品名全成乱码；
# c 的表头第一列被 BOM 污染成「﻿sku」，取不到 sku，SKU 全空。
# 表没有唯一约束：直接重导一遍会出现重复行。
set -e
mkdir -p /opt/inventory /data/import /var/lib/.evalstate
cat > /opt/inventory/import.py <<'PY'
#!/usr/bin/env python3
"""用法：python3 import.py <csv 文件>...   把供应商 CSV 追加导入库存库"""
import csv, os, sqlite3, sys

DB = "/opt/inventory/inventory.db"
c = sqlite3.connect(DB)
c.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, sku TEXT, name TEXT, qty INTEGER, price REAL, supplier TEXT)")
for path in sys.argv[1:]:
    supplier = os.path.basename(path).rsplit(".", 1)[0]
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        n = 0
        for row in csv.DictReader(f):
            c.execute("INSERT INTO items (sku, name, qty, price, supplier) VALUES (?, ?, ?, ?, ?)",
                      (row.get("sku", ""), row.get("name", ""), int(row.get("qty") or 0), float(row.get("price") or 0), supplier))
            n += 1
    print("%s：导入 %d 行" % (path, n))
c.commit()
PY
python3 - <<'PY'
import csv, json
A = [("A-1001", "不锈钢保温杯 500ml", 120, 39.9), ("A-1002", "陶瓷马克杯（白）", 300, 18.5), ("A-1003", "玻璃密封罐 1L", 85, 25.0),
     ("A-1004", "竹制砧板·大号", 40, 59.0), ("A-1005", "硅胶锅铲", 210, 12.8), ("A-1006", "铸铁平底锅 28cm", 32, 199.0),
     ("A-1007", "厨房纸巾 6 卷装", 500, 16.9), ("A-1008", "保鲜膜 30m", 260, 9.9), ("A-1009", "电热水壶 1.7L", 48, 89.0),
     ("A-1010", "儿童餐具套装", 75, 45.0), ("A-1011", "咖啡滤纸 100 张", 150, 14.5), ("A-1012", "调味瓶三件套", 66, 32.0)]
B = [("B-2001", "纯棉毛巾（灰）", 400, 15.9), ("B-2002", "珊瑚绒浴巾", 120, 49.0), ("B-2003", "防滑地垫 60×90", 90, 39.0),
     ("B-2004", "牙刷架·壁挂式", 140, 22.0), ("B-2005", "洗衣凝珠 52 颗", 230, 36.9), ("B-2006", "晾衣架（10 只装）", 310, 19.9),
     ("B-2007", "收纳箱 45L", 70, 55.0), ("B-2008", "香薰蜡烛·雪松", 60, 68.0), ("B-2009", "除湿袋 12 包", 180, 25.9),
     ("B-2010", "浴室置物架", 55, 79.0)]
C = [("C-3001", "无线鼠标", 95, 69.0), ("C-3002", "机械键盘·青轴", 40, 239.0), ("C-3003", "USB-C 扩展坞", 60, 159.0),
     ("C-3004", "显示器支架", 35, 129.0), ("C-3005", "笔记本散热垫", 80, 59.0), ("C-3006", "Type-C 数据线 2m", 400, 19.9),
     ("C-3007", "降噪耳机", 25, 499.0), ("C-3008", "桌面理线器", 150, 12.0)]
def write(path, rows, enc):
    with open(path, "w", encoding=enc, newline="") as f:
        w = csv.writer(f)
        w.writerow(["sku", "name", "qty", "price"])
        w.writerows(rows)
write("/data/import/supplier_a.csv", A, "gbk")
write("/data/import/supplier_b.csv", B, "gbk")
write("/data/import/supplier_c.csv", C, "utf-8-sig")
json.dump({"supplier_a": A, "supplier_b": B, "supplier_c": C}, open("/var/lib/.evalstate/expected.json", "w"), ensure_ascii=False)
PY
cd /opt/inventory && python3 import.py /data/import/supplier_a.csv /data/import/supplier_b.csv /data/import/supplier_c.csv >/dev/null
