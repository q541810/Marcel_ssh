#!/bin/bash
# 定时任务跑不出报表有三个原因，都来自「cron 的运行环境和登录 shell 不一样」：
# 1) reportctl 所在的 /opt/report/bin 只在 root 的 .bashrc/.profile 里加进了 PATH；
# 2) 必需的 REPORT_DB 也只在那里 export；
# 3) gen.sh 用相对路径写 out/，cron 的工作目录是 /root，就算跑成也写到 /root/out。
# 没有邮件服务，cron 的报错被直接丢掉，看不到任何提示。
set -e
mkdir -p /opt/report/bin /opt/report/out
cat > /opt/report/bin/reportctl <<'SH'
#!/bin/bash
if [ -z "$REPORT_DB" ]; then echo "reportctl: 未设置 REPORT_DB" >&2; exit 2; fi
echo "日报 db=$REPORT_DB 生成于 $(date '+%F %T')"
echo "订单数 1284，退款 37"
SH
chmod +x /opt/report/bin/reportctl
cat > /opt/report/gen.sh <<'SH'
#!/bin/bash
# 生成当天日报到 out/
mkdir -p out
reportctl > out/report-$(date +%F).txt
SH
chmod +x /opt/report/gen.sh
# 放在 .bashrc 最前面：SSH 执行命令时也会读到，所以「手动跑完全正常」
sed -i '1i export PATH=$PATH:/opt/report/bin\nexport REPORT_DB=sales_prod_7781' /root/.bashrc
printf 'export PATH=$PATH:/opt/report/bin\nexport REPORT_DB=sales_prod_7781\n' >> /root/.profile
# 用户昨天手动跑出来的那份
(cd /opt/report && PATH=$PATH:/opt/report/bin REPORT_DB=sales_prod_7781 ./gen.sh)
mv /opt/report/out/report-$(date +%F).txt /opt/report/out/report-$(date -d yesterday +%F).txt
touch -d yesterday /opt/report/out/report-$(date -d yesterday +%F).txt
echo "* * * * * /opt/report/gen.sh" | crontab -
cron
