#!/bin/bash
set -e
chmod +x /opt/backup/backup.sh
(crontab -l 2>/dev/null || true; echo "0 3 * * * /opt/backup/backup.sh") | crontab -
/opt/backup/backup.sh
