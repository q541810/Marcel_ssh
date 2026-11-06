#!/bin/bash
sed -i '2i cd /opt/report\nexport PATH=$PATH:/opt/report/bin\nexport REPORT_DB=sales_prod_7781' /opt/report/gen.sh
echo "原因：cron 运行时不读 .bashrc/.profile，PATH 里没有 /opt/report/bin、也没有 REPORT_DB 环境变量；而且 cron 的工作目录是 /root，gen.sh 里的相对路径 out/ 会写到 /root/out。已在 gen.sh 开头切到 /opt/report 并补上这两个环境变量。"
