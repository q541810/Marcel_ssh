#!/bin/bash
set -e
find /var/log/myapp -maxdepth 1 -type f -name 'app.log.*' -mtime +7 -delete
