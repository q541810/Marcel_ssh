#!/bin/bash
y=$(date -d yesterday +%d/%b/%Y)
awk -v d="[$y" 'index($4, d)==1 && $9 ~ /^5/ {split($7,a,"?"); c[a[1]]++} END{for(k in c) print c[k], k}' /var/log/nginx-big/access.log | sort -rn | head -3
