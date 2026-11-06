#!/bin/bash
set -e
grep -rl 'old\.example\.com' /etc/myapp | grep -v '/legacy\.conf$' | xargs sed -i 's/old\.example\.com/new.example.com/g'
