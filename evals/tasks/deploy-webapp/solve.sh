#!/bin/bash
set -e
cat > /opt/webapp/start.sh <<'S'
#!/bin/bash
cd /opt/webapp
nohup python3 app.py >/var/log/webapp.log 2>&1 &
S
chmod +x /opt/webapp/start.sh
setsid /opt/webapp/start.sh
sleep 1.5
