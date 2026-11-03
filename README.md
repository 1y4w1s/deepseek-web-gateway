# DeepSeek Web Gateway（Windows 一键本地部署）

这是一个**独立的本地启动器**，复用开源项目 [dekrezz/FreeDeepseekAPI](https://github.com/dekrezz/FreeDeepseekAPI)，把个人登录的 DeepSeek 网页会话提供为 OpenAI 兼容 API，供 DeepSeek Harness（DSH）或其他本机客户端调用。

本仓库只包含启动脚本，**不包含账号、Token、Cookie、浏览器资料或运行日志**。首次启动时自动从上游 `stable` 分支下载程序。

> 非官方实验性项目，不保证无限额度、长期可用或与 DSH 原生工具调用完全兼容。DeepSeek 网页接口变化可能导致不可用，请留意服务条款和账号使用风险。本项目仅为个人本机使用准备。

## Windows 部署

**前置条件：** Node.js 18+、Git、Google Chrome，以及可以访问 `https://chat.deepseek.com` 的网络。

1. 在 GitHub 选择 **Code → Download ZIP**，然后**完整解压**到固定文件夹；或用下面的 Git 命令克隆。
2. 双击仓库根目录的 **`Start.vbs`**。
3. 首次启动自动下载上游程序；在 Chrome 窗口中登录**当前电脑自己的** DeepSeek 账号，并按登录窗口提示操作。
4. 登录成功后启动本地 API 并打开管理页面；同时会在 Windows 桌面创建 **DeepSeek Web API** 快捷方式。
5. 后续双击快捷方式即可复用已有服务，不需要重新克隆，正常情况下也不需要重新登录。

```powershell
git clone https://github.com/1y4w1s/deepseek-web-gateway.git
```

不要在压缩包预览界面直接双击 `Start.vbs`；部署后不要随意移动仓库目录，否则桌面快捷方式将失效。

## 本机 API 与 DSH 配置

| 项目 | 设置 |
| --- | --- |
| Base URL | `http://127.0.0.1:9655/v1` |
| 管理页面 | `http://127.0.0.1:9655/dashboard` |
| 健康检查 | `http://127.0.0.1:9655/health` |
| API 协议 | OpenAI Chat Completions |
| API Key | `local`（未开启代理密钥认证时的占位值） |
| 普通模型 | `deepseek-v4-flash-nosearch` |
| 思考模式 | `deepseek-v4-flash-thinking-nosearch` |
| 思考 + DeepSeek 网页搜索 | `deepseek-v4-flash-thinking` |

在 DSH 中**新增**自定义模型提供商，无需替换原有账号或默认 Provider。首次在独立测试会话中以**只读权限**验证工具调用、流式输出及多轮上下文。网关支持用 `x-agent-session` 维持独立会话，客户端如不传递会由代理按客户端特征分配。

默认只监听 `127.0.0.1`，**不对局域网或公网开放**。在另一台电脑使用时，在那台电脑本地部署并登录，不要复制当前电脑的凭证。

## GitHub 源码读取与网页桥接兼容性

本仓库新增一个极小的**上游兼容补丁**：启动时运行 `patches/apply-upstream.cjs`，只更正 FreeDeepseekAPI 在工具说明、工具提醒和异常恢复中对联网能力的冲突描述。

- 在 `-nosearch` 模型下，如果 DSH 真正提供 `websearch`、`webfetch` 或类似工具，网关不再提示模型禁止调用这些已提供的工具。
- 要查看 **GitHub 仓库源码**，优先让 DSH 使用已授权的 Git/终端工具，在独立目录执行 `git clone` 并实际读取文件；网页搜索结果不能代替源码文件。
- 如果 DSH 根本没有提供联网、Git 或终端工具，这个补丁不会创造它们，也不能修复 DNS、代理、GitHub 访问受限的问题。
- DSH 的 `web_search` / `web_fetch` 要求自身装载对应工具、且选择的搜索/抓取服务就绪；`-nosearch` 只关闭 DeepSeek 网页搜索，不会自动安装 DSH 联网工具。没有这些工具时，可先改选 `deepseek-v4-flash-thinking` 使用 DeepSeek 网页搜索，但要验证 GitHub **源码文件**仍需实际 Git/终端读取。
- 当使用带搜索的模型时，DeepSeek 网页搜索仍由 DeepSeek 端实现；需要可验证的源码文件时仍应使用 DSH 工具。

补丁是幂等的；上游代码发生不兼容变更时会**停止启动并给出错误**，不会默默假装已经修复。排查 `runtime/patch.stderr.log`。

安装并完成首次运行之后，可以在仓库目录运行回归测试：

```powershell
node --test tests/compat.test.cjs
```

测试涵盖：新旧提示矛盾、GitHub 源码访问指引、工具恢复提示、补丁重复执行和上游变更时的明确失败。**这不等于完成 DSH 真实工具调用验收。**

注意：若启动时检测到本机 **9655 已经运行**，启动器会直接打开控制台，不会热替换当前进程中的代码。需要应用新版本补丁时，先正常停止属于该网关的进程，再启动；不要批量终止其他 Node 进程。

## 文件与排障

- `Start.vbs`：一键入口，并在首次运行时创建桌面快捷方式。
- `Start.ps1`：检查现有服务、下载上游、触发登录并启动服务。
- `Authenticate.ps1`：首次人工浏览器登录。
- `.gitignore`：排除运行目录、日志及可能的密钥文件。
- `runtime/upstream/`：首次运行后创建的上游源码、登录状态和浏览器数据；**严禁上传**。
- `runtime/launcher.log`：启动错误，发生错误时自动用记事本打开。
- `runtime/git.stderr.log`：Git 下载错误。
- `runtime/server.stderr.log`：API 服务错误。
- `runtime/server.pid`：启动进程 PID。停止时要核实进程归属，不要批量结束所有 `node.exe`。

若网页登录失效，在本仓库文件夹打开 PowerShell，执行 `./Authenticate.ps1` 重新登录。健康检查的 HTTP 200 仅证明 API 启动，不等于 DSH 的真实工具链通过。

## 验收说明

原先一台 Windows 机器已验证上游代理的健康检查、模型列表、连续对话和工具调用格式。**本仓库的一键可移植启动器只完成了静态检查，尚未在第二台电脑进行真实首次安装验收**；以目标电脑实际结果为准。

**上游版权：** 代理服务来自 [FreeDeepseekAPI](https://github.com/dekrezz/FreeDeepseekAPI)（Apache-2.0）；本仓库不镜像其源码。
