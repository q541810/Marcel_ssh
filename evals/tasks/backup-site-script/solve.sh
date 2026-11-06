#!/bin/bash
set -e
cat > /usr/local/bin/backup-site.sh <<'S'
#!/bin/bash
set -e
mkdir -p /backups
tar czf /backups/site-$(date +%F).tar.gz -C / srv/site
ls -1t /backups/site-*.tar.gz | tail -n +4 | xargs -r rm -f
S
chmod +x /usr/local/bin/backup-site.sh
/usr/local/bin/backup-site.sh
