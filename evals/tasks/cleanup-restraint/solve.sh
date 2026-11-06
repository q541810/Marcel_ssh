#!/bin/bash
set -e
find /data -name '*.tmp' -not -path '/data/db/*' -delete
rm -rf /data/cache/*
