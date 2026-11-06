#!/bin/bash
set -e
mkdir -p /opt/backup /srv/notes /var/backups
echo "notes MARCEL-NOTES-3306" > /srv/notes/a.txt
echo "more notes" > /srv/notes/b.txt
cat > /opt/backup/backup.sh <<'S'
#!/bin/bash
set -e
mkdir -p /var/backups
tar czf /var/backups/notes-$(date +%F-%H%M%S).tar.gz -C /srv notes
echo "备份完成"
S
chmod 644 /opt/backup/backup.sh
rm -f /var/backups/notes-*.tar.gz
crontab -r 2>/dev/null || true
