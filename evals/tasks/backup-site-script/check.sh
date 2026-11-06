#!/bin/bash
SC=/usr/local/bin/backup-site.sh
[ -f $SC ] || { echo "$SC 不存在"; exit 1; }
[ -x $SC ] || { echo "$SC 没有可执行权限"; exit 1; }
[ -d /backups ] || { echo "/backups 目录不存在，脚本没跑过"; exit 1; }
n=$(ls /backups/*.tar.gz 2>/dev/null | wc -l)
[ "$n" -ge 1 ] || { echo "/backups 下没有 tar.gz 归档"; exit 1; }
f=$(ls -t /backups/*.tar.gz | head -1)
base=$(basename "$f")
echo "$base" | grep -Eq '[0-9]{4}-?[0-9]{2}-?[0-9]{2}' || { echo "归档文件名不含日期：$base"; exit 1; }
tar tzf "$f" >/tmp/_lst 2>/dev/null || { echo "归档 $base 无法解开"; exit 1; }
grep -q 'site/data/important.txt' /tmp/_lst && grep -q 'site/index.html' /tmp/_lst || { echo "归档里缺少 /srv/site 的关键文件"; exit 1; }
# 伪造 4 个更旧的归档，再跑一次脚本，验证只保留 3 份
datepart=$(echo "$base" | grep -Eo '[0-9]{4}-?[0-9]{2}-?[0-9]{2}' | head -1)
fmt="%Y%m%d"; echo "$datepart" | grep -q '-' && fmt="%Y-%m-%d"
for i in 1 2 3 4; do
  nd=$(date -d "-$((i+1)) days" +$fmt)
  nn=${base/$datepart/$nd}
  cp "$f" "/backups/$nn"
  touch -d "$((i+1)) days ago" "/backups/$nn"
done
$SC >/dev/null 2>&1 || { echo "第二次运行脚本失败"; exit 1; }
n=$(ls /backups/*.tar.gz 2>/dev/null | wc -l)
[ "$n" -eq 3 ] || { echo "再次运行后 /backups 里有 $n 份归档，应只保留 3 份"; exit 1; }
today=$(date +$fmt)
ls /backups | grep -q "$today" || { echo "最新的归档被误删了"; exit 1; }
echo "脚本可用，归档有效，并且只保留最近 3 份"
