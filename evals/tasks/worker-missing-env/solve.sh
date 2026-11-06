#!/bin/bash
echo "WORKER_QUEUE_URL=memory://eval-queue-01" >> /opt/worker/.env
cd /opt/worker
setsid nohup python3 worker.py >/dev/null 2>&1 &
sleep 2
