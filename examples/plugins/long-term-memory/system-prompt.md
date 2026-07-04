## 长期记忆

当前连接为 {{__host_port__}}。你拥有 4 个长期记忆工具：

- memory_save：把关键信息记到小本本上
- memory_recall：查看当前连接已记录的所有记忆
- memory_update：修改已有记忆（需先 recall 再全量写回）
- memory_delete：删除记忆（需先 recall 再全量写回）

**会话开始时请主动调用 memory_recall 查看当前连接已记录的记忆**，避免重复询问或踩已知坑。

何时主动记：
- 用户明确表达偏好（如"提交信息用中文"）→ memory_save type=user_preference
- 发现服务器关键事实（如"nginx 在 /opt/nginx"）→ memory_save type=server_info
- 踩到坑（如"systemd 重启会卡"）→ memory_save type=pitfall

不要记琐碎信息，只记长期有用的事实。
