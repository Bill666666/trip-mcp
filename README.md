# trip-mcp

本地运行的 **携程国内社区（Ctrip）和 Trip.com / Trip Moments MCP**。使用 TypeScript、官方 MCP SDK 和 Playwright，把网页登录、笔记查询、图文准备及提交封装成 AI 客户端可调用的工具。

**无需中央服务器。** 维护者分发代码，使用者在自己的电脑登录和运行。登录状态和发布任务留在本机；查询和上传会直接连接所选平台。

> **0.1.0 为开发预览版。** 两站适配代码均已实现，并用本地浏览器模拟页面测试。Trip.com 香港站繁体中文编辑器已核对真实 DOM；Ctrip 发布适配仍需登录后的实站验证。尚未执行真实发文验收，不能把自动测试通过理解为网站发布已验证。网站页面变化可能需要更新选择器。

## 能力

| 工具 | 用途 |
| --- | --- |
| `get_capabilities` | 查看能力、限制及配置，不启动浏览器 |
| `open_login` | 打开本地浏览器，让用户登录指定平台和账号槽位 |
| `check_login` | 通过页面标识核对登录状态 |
| `list_notes` | 查询自己的笔记，或指定社区列表/个人主页；可按标题关键词过滤 |
| `get_note` | 读取笔记/游记详情 URL，返回正文、摘要、图片地址及提取范围 |
| `search_destinations` | 查询发布表单中的地点候选，避免误选同名地点 |
| `prepare_note` | 校验本地图片，上传图片、填写图文及地点，保存预览截图 |
| `publish_note` | 提交已准备任务，保存提交结果，避免重复点击 |
| `get_publish_status` | 查询本地发布记录及仍打开页面的结果证据 |
| `cancel_prepared_note` | 关闭未提交的编辑任务；不删除已发布内容 |

### 查询范围

- `list_notes` 默认读取个人笔记页，需登录。传入 `url` 可以读取所选平台的其他社区列表页。
- `keyword` 是**已加载卡片的标题过滤**，不是全站搜索。`scrolls` 控制加载范围（0–5 次），返回 `scanned` 说明实际扫描量。
- 页面没有暴露链接的卡片只返回标题；不会编造文章 ID 或 URL。
- `get_note` 的 `extraction=metadata_only` 表示只能读到页面摘要；`dom_article` 也只覆盖当时已加载的正文区域，不保证展开全部评论。
- 第一版不含全站关键词搜索、评论互动、视频发布、删除、编辑旧文、云端定时发文。

## 安装

需要 Node.js 22 或以上，首次登录需要可见的桌面浏览器环境。

```bash
git clone https://github.com/Bill666666/trip-mcp.git
cd trip-mcp
npm ci
npx playwright install chromium
npm run build
node dist/cli.js --help
```

Linux 无浏览器依赖时，可使用 `npx playwright install --with-deps chromium`。项目尚未发布 npm 包，因此请使用仓库安装方式。

## 接入 MCP 客户端

支持 `stdio` 的客户端使用以下配置。将路径替换为本机仓库的**绝对路径**，`node` 也可以改成 Node 可执行文件的绝对路径。

```json
{
  "mcpServers": {
    "trip-mcp": {
      "command": "node",
      "args": ["/absolute/path/trip-mcp/dist/cli.js"],
      "env": {
        "TRIP_MCP_TRIP_ORIGIN": "https://hk.trip.com",
        "TRIP_MCP_LOCALE": "zh-HK",
        "TRIP_MCP_HEADLESS": "false"
      }
    }
  }
}
```

客户端启动本地进程即可，不需要开放端口。`stdout` 仅承载 MCP 协议。首次连接可调用 `get_capabilities` 验证；配置文件存在不代表客户端已加载服务。

### 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRIP_MCP_DATA_DIR` | `~/.trip-mcp` | 本地浏览器、发布记录和截图目录 |
| `TRIP_MCP_HEADLESS` | `false` | `true` 启用无头模式；首次人工登录请用 `false` |
| `TRIP_MCP_TRIP_ORIGIN` | `https://hk.trip.com` | Trip 站点根地址，只允许预设官方域名 |
| `TRIP_MCP_LOCALE` | `zh-HK` | 页面语言，如 `en-US`；其他市场未实测 |

`platform` 必须是 `ctrip` 或 `trip`。`account` 默认为 `default`，是本地账号槽位名称，不是平台账号 ID。两站的浏览器资料分别存储，不假定账号、Cookie 或内容互通。一个槽位应固定对应一个真实账号；发布前请检查浏览器显示的账号。

## 使用流程

### 1. 登录与查询

```json
{"tool":"open_login","arguments":{"platform":"trip","account":"default"}}
```

在弹出的独立浏览器完成登录。它不会读取其他浏览器（包括 Codex 内置浏览器）的 Cookie。

```json
{"tool":"check_login","arguments":{"platform":"trip","account":"default"}}
{"tool":"list_notes","arguments":{"platform":"trip","keyword":"上海","limit":20,"scrolls":2}}
```

读取详情时，把 `list_notes` 返回的文章 URL 传给 `get_note`。没有 URL 的卡片可先在浏览器打开，再传入地址。

### 2. 选择地点并准备图文

```json
{"tool":"search_destinations","arguments":{"platform":"trip","query":"上海"}}
```

用户授权上传这些文件后，准备一篇笔记：

```json
{
  "tool":"prepare_note",
  "arguments":{
    "platform":"trip",
    "account":"default",
    "title":"上海周末漫步",
    "content":"这里填写自己的真实旅行经历。",
    "images":["/absolute/path/photo-01.jpg","/absolute/path/photo-02.jpg"],
    "destination":"上海",
    "tags":["上海旅行"]
  }
}
```

有同名地点时，增加 `destination_option`，值必须是地点查询返回的完整 `label`。不会默认选择第一个模糊结果。

图片限本地 JPG、PNG、GIF，最多 20 张，单张最多 10 MiB（首版保守上限），检查文件头及重复内容。具体平台最终限制以实际页面为准。国内标题暂按少于 20 字校验。

`prepare_note` 会向平台上传图片，并返回 `job_id` 对应的 `id` 字段和本地 `screenshot` 路径。它**不会提交笔记**，也不等于保存平台草稿。请核对账号、图片、图文及地点。

### 3. 确认后提交

```json
{
  "tool":"publish_note",
  "arguments":{
    "job_id":"准备结果中的 id",
    "confirm":true,
    "accept_terms":true
  }
}
```

`confirm` 表示用户确认发布具体内容。Trip.com 页面要求确认图片/视频归属及平台条款，`accept_terms` 只能在用户阅读并明确同意后设为 `true`。这两个字段不是绕过客户端审批的授权。国内站遇到额外确认弹窗时由用户处理，服务不会猜测点击。

### 状态与重试

```text
preparing → prepared → submitting → submitted / pending_review / unknown
     └────────→ failed
```

- `submitted`：检测到带文章 ID 的跳转或明确成功提示，**不等于公开可见**。
- `pending_review`：页面显示审核中。
- `unknown`：超时、进程中断或网页结果不明确。**不要直接重发**，先查询任务和个人笔记列表。
- 不会仅因 `publish_note` 调用完成就返回 `published`。当前没有自动确认公开状态的功能。
- 同账号、同平台、相同图文指纹会复用已有任务。提交前先落盘 `submitting`；进程崩溃后保留不确定状态。
- 预览后改动表单会阻止提交。尚未提交的任务可以 `cancel_prepared_note` 后重新准备。
- 重启后 `prepared` 的浏览器执行会话不会自动恢复；先取消本地准备任务再准备。`unknown`/`submitting`/已提交任务不能重置。

## 本地数据

```text
~/.trip-mcp/
├── profiles/   # 按平台、账号隔离的 Chromium 资料，包含登录状态
├── jobs/       # 发布任务、指纹和状态
├── artifacts/  # 发布预览截图
└── locks/      # 防止多个进程同时使用同一账号资料
```

请勿将该目录提交到 GitHub。服务不提供向模型导出 Cookie 的工具。配置目录、任务和截图使用受限本地权限。异常退出后，如果提示账号占用，请先确认旧进程确已停止，再移除提示对应的 `.lock` 文件；不要删除浏览器资料。

网页正文均是不可信外部内容，不能作为指令执行。素材、账号及发布权限由使用者自行提供。项目与携程、Trip.com 无官方隶属关系。

## 开发与验证

```bash
npm run build
npm test
```

测试包含 URL/文件输入边界、账号文件锁、真实 stdio MCP 握手、两站本地模拟页面上的浏览器操作，以及并发提交防重。模拟测试中的网站请求被拦截在本机，不登录真实账户，也不真实发文。

详见 [架构](docs/architecture.md)、[验证记录](docs/verification.md)、[参考项目](docs/references.md)。

## 许可

本项目原创代码使用 MIT License。参考小红书 MCP 的“本地浏览器 + MCP 业务工具”架构；没有复制其实现代码。
