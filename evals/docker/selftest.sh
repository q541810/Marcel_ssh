#!/bin/bash
# 自测：对每道题验证「setup 后 check 不通过、solve 后 check 通过」
# 回答类题（task.json 含 expectInAnswer）：check 只查没搞破坏，两次都应通过；
# 且 solve.sh 的输出必须匹配全部 expectInAnswer 正则。
# 用法：bash selftest.sh [task-id ...]   不带参数则跑全部
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
IMG=marcel-eval-target:latest
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../tasks" || exit 1
ids=("$@"); [ ${#ids[@]} -eq 0 ] && ids=($(ls -d */ | tr -d /))
pass=0; fail=0
for id in "${ids[@]}"; do
  c="marcel-selftest-$id"
  answer_type=0; grep -q '"expectInAnswer"' "$id/task.json" && answer_type=1
  docker rm -f "$c" >/dev/null 2>&1
  docker run -d --rm --name "$c" "$IMG" >/dev/null || { echo "[失败] $id：容器启动失败"; fail=$((fail+1)); continue; }
  docker cp "$id/." "$c:/tmp/task" >/dev/null
  ok=1; msg=""; before=""; after=""
  if ! docker exec "$c" bash /tmp/task/setup.sh >/tmp/_st_setup.log 2>&1; then ok=0; msg="setup 执行失败：$(tail -3 /tmp/_st_setup.log | tr '\n' ' ')"; fi
  if [ $ok = 1 ]; then
    out=$(docker exec "$c" bash /tmp/task/check.sh 2>&1); rc=$?
    before="$(echo "$out" | tail -1)"
    if [ $answer_type = 0 ] && [ $rc = 0 ]; then ok=0; msg="setup 后 check 就通过了（题目已是完成态）：$before"; fi
    if [ $answer_type = 1 ] && [ $rc != 0 ]; then ok=0; msg="回答类题 setup 后 check 应通过：$before"; fi
  fi
  if [ $ok = 1 ]; then
    solve_out=$(docker exec "$c" bash /tmp/task/solve.sh 2>&1) || { ok=0; msg="solve 执行失败：$(echo "$solve_out" | tail -3 | tr '\n' ' ')"; }
  fi
  if [ $ok = 1 ]; then
    out=$(docker exec "$c" bash /tmp/task/check.sh 2>&1); rc=$?
    after="$(echo "$out" | tail -1)"
    [ $rc != 0 ] && { ok=0; msg="solve 后 check 仍不通过：$after"; }
  fi
  if [ $ok = 1 ] && [ $answer_type = 1 ]; then
    for pat in $(grep '"expectInAnswer"' "$id/task.json" | sed 's/.*\[//; s/\].*//' | grep -o '"[^"]*"' | tr -d '"'); do
      echo "$solve_out" | grep -Eiq -- "$pat" || { ok=0; msg="solve 输出不匹配 expectInAnswer：$pat"; }
    done
  fi
  if [ $ok = 1 ]; then echo "[通过] $id | 初始：$before | 解后：$after"; pass=$((pass+1))
  else echo "[失败] $id | $msg"; fail=$((fail+1)); fi
  docker rm -f "$c" >/dev/null 2>&1
done
echo "合计：通过 $pass，失败 $fail"
[ $fail = 0 ]
