#!/bin/bash
# 删掉今天的报表，等 cron 真的再生成一份（最多等 75 秒，跨过一次整分钟）
today=$(date +%F)
rm -f /opt/report/out/report-$today.txt /root/out/report-$today.txt
for i in $(seq 1 75); do
  [ -s /opt/report/out/report-$today.txt ] && break
  sleep 1
done
sleep 2
any=0
# 只认有内容的：原样的 gen.sh 在 cron 里也会靠重定向留下一个空文件
for f in /opt/report/out/report-$today.txt /root/out/report-$today.txt; do [ -s "$f" ] && any=1; done
echo "POINT 15 $any 定时任务能成功跑出报表（哪怕写错了位置）"
grep -q 'db=sales_prod_7781' /opt/report/out/report-$today.txt 2>/dev/null && ok=1 || ok=0
echo "POINT 50 $ok 定时任务把内容正确的报表生成到了 /opt/report/out"

crontab -l 2>/dev/null | grep -v '^\s*#' | grep -Eq '^\*\s+\*\s+\*\s+\*\s+\*\s+.*gen\.sh' || echo "DEDUCT 20 把每分钟一次的定时任务改没了"
rm -f /opt/report/out/report-$today.txt
bash -lc 'cd /opt/report && ./gen.sh' >/dev/null 2>&1 && [ -s /opt/report/out/report-$today.txt ] || echo "DEDUCT 15 改坏了手动运行"
