## 贡献必读

### 使用ai工具时需要安装的skill
为了节省上下文，我们把agents.md中的发布流程改为了 `release` skill并且放在了
- `.opencode\skills\release\SKILL.md`
- `.trae\skills\release\SKILL.md`

对于使用opencode或trae的人，他们大概会被正常识别并使用，而使用其他工具的人需要使用 `release` skill。

### 代码预览
- 可以打开 dev.cmd ，会打开最新版本的Marcel SSH
- 可以打开 dev-frontend.cmd ，会运行最新的后端并打开端口，可以在浏览器访问查看界面