# CorePilot for VS Code

扩展连接已经运行的 CorePilot 服务，在编辑器中查看项目关联的优化任务、当前进展、报告和冻结候选补丁。任务执行、验证和持久化仍由服务端负责；关闭编辑器不会自动取消任务。

1. 启动包含网页的 CorePilot 服务。在 VS Code 中执行“CorePilot: 连接 CorePilot 服务”，默认地址为 `http://127.0.0.1:4317`。
2. 如果服务要求认证，执行“CorePilot: 设置服务连接令牌”。令牌按完整服务地址隔离，保存在 VS Code SecretStorage，不放入配置、网页地址或日志。留空可移除该地址的令牌。
3. 执行“CorePilot: 选择项目”，在 CorePilot 侧栏查看关联任务。服务端目前没有在工作流中记录项目 ID，列表按配置路径或源码目录关联，可能包含其他项目的任务；最多查询最近 200 条工作流。
4. 单击任务查看进展，右键可打开或保存报告、查看候选补丁、请求取消。取消请求发出后须等待后台确认；报告分别记录执行、正确性、性能、批准和交付，补丁本身不是已验证结果。

“在网页创建优化任务”和“在网页创建测试任务”会打开现有服务的相应页面，需要该服务启用网页。请在网页选择项目并填写条件；编辑器中的文件、选区或提示词不会被自动提交，也不会被作为候选修改范围。扩展不启动或停止后台，不在本机另起模型或模拟实验。远程服务返回的源码路径仅作为服务端信息，不会被当作本地文件打开。

## 开发验证

在仓库根目录安装依赖后运行：

```sh
npx tsc -p extensions/vscode/tsconfig.json --noEmit
node extensions/vscode/build.mjs
node --import tsx --test --test-concurrency=1 extensions/vscode/test/client.test.mts extensions/vscode/test/extension-ui.test.mts
node scripts/verify-vsix-install.mjs
```

API 和命令测试使用本地服务、临时 Git 仓库及模拟模型，不连接真实 Runner，也不产生性能证据。命令测试从生成的 VSIX 读取实际扩展代码和清单，并模拟 VS Code API。

最后一条命令在 Windows 上使用未切换的独立隐藏桌面、临时用户数据和扩展目录，加载实际 VSIX 并检查命令注册；需要本机 VS Code 和 Python 3。可用 `COREPILOT_VSCODE_PATH` 指定 `Code.exe`。其他平台会明确标记未执行此项验证，不代表对应 Extension Host 已通过。
