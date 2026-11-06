# 构建评测靶机镜像（平时不用手动跑：评测台和自测发现 Dockerfile 改过会自动重建）
node "$PSScriptRoot\image.mjs" --force
