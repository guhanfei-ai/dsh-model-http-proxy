# dsh-model-http-proxy

给 DeepSeek Harness（DSH）加「**按域名选择代理，其余使用本机默认网络**」的能力，不修改任何 DSH 官方代码。

同时配置多个命名代理，让不同域名使用不同出口；全局直连规则绕过本插件的所有代理。这里的“直连”是沿用宿主／本机默认网络，不是强制物理直连：不会关闭系统代理、VPN 或 TUN，也不改变宿主原有网络设置。

> **这是域名级路由，不是提供方级路由。** 插件名里的 `model` 只说明使用场景：实际规则写在域名上。共用同一域名的请求会得到同一个结果——例如 `chatgpt.com` 上的模型接口和网页搜索会一起走代理。若你需要「同一域名下只代理模型请求」，那属于 v0.2 的 provider 级路由，本版本不提供。
>
> **只覆盖 HTTP `fetch`。** WebSocket 传输不经过 `globalThis.fetch`，因此不受本插件控制。

> **状态**：v0.1.3 已发布，包含全局直连与多代理卡片。设置页在 DSH 左栏「设置 → M-H-Proxy」，域名以可编辑列表管理；下拉候选来自**聊天框当前可选的模型**（`session.modelCatalog` 的可路由 provider），并逐行标注来源。

## 功能

- **显式规则**：只代理启用卡片里明确列出的域名；未命中时使用本机默认网络。空卡片不代理任何域名，空代理列表不代理任何请求，绝不会隐式开启全量代理。
- **全局直连第一优先级**：命中全局直连规则时，始终走直连，不受代理卡片影响；例如直连 `api.openai.com`、代理 `*.openai.com`。默认网络使用宿主共享 dispatcher，而不是另建一个强制直连 Agent。
- **多代理确定性选路**：精确 host 优先于通配规则；通配规则中后缀更具体的优先。卡片名称、序号、排列顺序不决定出口，不串联代理，也不自动故障转移。
- **唯一后缀格式**：`openai.com` 只匹配自身；`*.openai.com` 覆盖根域及所有层级子域；`.openai.com`、`*-openai.com` 等格式拒绝保存。不会匹配 `fake-openai.com` 或 `openai.com.evil.com`。
- **卡片式设置页**：域名规则说明 → 全局直连区 → 多代理卡片 → 统一保存。每张卡可改名、启停、添加和删除；停用不丢配置，删除需再次确认，保存前可整页撤销。
- **域名管理**：下拉负责添加，生效列表逐行提供来源、编辑、删除，右侧按钮可手工添加；所有卡片与全局规则一起保存，并保留版本冲突恢复。
- **两列候选菜单**：左侧域名、右侧公司／提供方名称，预置项只显示公司名、不附带模型品牌；作者预置在上、用户模型／已保存域名在下，用横线分隔，不再显示“内置”前缀。代理菜单把 OpenAI 规则放在最前；已添加／已被其它代理使用的候选仍可见并置灰说明。支持方向键、Home/End、Enter/空格、Escape 与输入首字母定位；先选择，再点“添加”，不会直接保存。
- **三种来源**：聊天框可选模型的域名、手工添加域名／后缀、作者预埋通配规则。首次仅初始化一张“代理1”；全局直连默认只有 `*.deepseek.com`，代理1默认只有 OpenAI、Anthropic、Google、xAI 四组（见下表）。已有配置与显式空列表不覆盖，删除的内置规则不复活，用户新增卡片从空规则开始；内置候选仍可手动重新选择。
- **冲突可见**：归一化后的同一规则不能同时属于两个启用代理，前后端都会拒绝；停用代理不参与冲突检查。更具体规则覆盖宽泛规则是合法例外。全局直连与代理重叠只作中性提示，不作为错误。
- **逐跳判定**：每次重定向都按该跳自己的域名重新决定是否走代理，不会沿用第一跳的结论
- **流式与原生类型**：请求体/响应体流式透传，返回的是平台原生 `Response`，调用方传入原生 `Request` 也能正常工作
- **配置校验与降级**：无效代理地址或无效域名条目会被拒绝；保存了坏配置时保留上一次可用路由并记录原因（凭据已脱敏），不会静默变成直连
- 支持代理协议：`http / https / socks5 / socks5h`（`socks` 视作 `socks5`）
- 设置改动下一次请求即生效：路由读取设置文档的实时值，保存后即刷新，无需重启

> **关于 SOCKS**：`socks5` 与 `socks5h` 都使用同一 SOCKS5 传输，目标主机名交给代理解析（即 5h 语义）。`socks4` / `socks4a` 未实现——undici 不提供该协议，写入时会被明确拒绝，而不是"保存成功但路由失效"。

## 路线图（v0.2+）

- **按提供方路由**：规则直接写提供方名（如 `kimi-coding → 代理A`），同一域名下只代理模型请求
- **WebSocket 覆盖**：让 Codex 这类可切换到 WS 的传输也受控
- 连通性测试按钮、每个域名的实际路由状态展示

## 安装

```sh
dsh plugin --profile web add dsh-model-http-proxy
```

> **兼容性**：需要提供 `settings.section` 槽位与 `remote.settings` 面（0.1.7+）；设置页不依赖宿主 primitives 的图标导出。已在 0.2.1-rc.2 真机验证。

## 使用

1. 打开 DSH **设置（左栏）→ M-H-Proxy**。
2. 先检查「全局直连域名 · 第一优先级」：这些规则命中的请求使用本机默认网络。
3. 在初始「代理1」卡片中填写代理地址（如 `http://127.0.0.1:7890`），检查作者内置的四组代理域名，然后启用该卡。名称可改，域名可下拉或手工添加，每条规则都可编辑、删除。
4. 可以继续添加其它代理；遇到同规则冲突时修改归属或停用其中一张卡。精确规则与更宽通配规则可以分别归属不同代理。
5. 点击整页「保存」后生效；不想保留草稿时点「撤销修改」。

正在行内编辑域名或确认删除代理时，必须先确认或取消再保存。停用卡片保留内容，但不参与选路。代理连接失败会报错，不会偷偷改成默认网络或另一个代理。

### 作者内置默认规则

| 默认位置 | 公司／服务 | 通配规则 |
| --- | --- | --- |
| 全局直连 | DeepSeek | `*.deepseek.com` |
| 代理1 | [OpenAI](https://developers.openai.com/api/reference/overview) | `*.openai.com`、`*.chatgpt.com` |
| 代理1 | [Anthropic](https://platform.claude.com/docs/en/api/overview) | `*.anthropic.com`、`*.claude.ai`、`*.claude.com` |
| 代理1 | [Google](https://ai.google.dev/api/models) | `*.googleapis.com`、`*.gemini.google.com` |
| 代理1 | [xAI](https://docs.x.ai/overview) | `*.x.ai`、`*.grok.com` |

只默认存在一张“代理1”，代理地址未填写时保持停用；不默认创建“代理2”。用户点击“添加代理”时，新卡片的域名列表为空，不复制作者规则或其它卡片。

这些是**规则匹配通配符，不是 DNS 泛解析设置**，包含根域及所有层级子域。`*.openai.com` 已覆盖 `auth.openai.com`，不再额外内嵌单独的 auth 规则。

Gemini API 位于 `generativelanguage.googleapis.com`，区域 Vertex API 也使用 `googleapis.com` 后缀，因此该默认规则**会同时覆盖其它 Google API**。不默认加入整个 `*.google.com`（避免将普通 Google 站点一并代理），也不加入与 Gemini AI 无关的 `gemini.com` 或社交站点 `*.x.com`。本清单是四家主要 AI 服务域名，不声称覆盖其所有资产域名／CDN。

作者默认值仅在对应字段缺失时种入。旧配置里已保存的自定义域名保留，显式 `[]` 原样保留，删除规则或卡片后不会自动恢复。候选下拉仍可显示模型目录中的其它域名；候选不等于自动生效的默认规则，每条内置规则会标注所属公司。

### 配置迁移

旧的 `proxy`／`proxyHosts`／`excludeHosts` 自动在内存中映射为“代理1”与全局直连，打开页面不会写回。第一次保存新界面时，整页原子写入 `proxies` 和 `excludeHosts`，同时清空旧 `proxy`／`proxyHosts`。

```json
{
  "proxies": [
    { "id": "local", "name": "本机代理", "enabled": true, "proxy": "http://127.0.0.1:7890", "proxyHosts": ["*.openai.com"] },
    { "id": "work", "name": "公司代理", "enabled": true, "proxy": "socks5://127.0.0.1:1080", "proxyHosts": ["api.openai.com"] }
  ],
  "excludeHosts": ["internal.openai.com"]
}
```

此例中 `api.openai.com` 走公司代理，其它 `openai.com` 根域／子域走本机代理，`internal.openai.com` 使用默认网络。

`proxies: []` 是明确关闭本插件代理的配置，不重新合入旧地址或 `DSH_HTTP_PROXY` 环境变量。该环境变量仅在旧字段配置路径中作为地址回退。内置域名删除后不恢复。

升级提示：旧 `.example.com` 写法需要手工编辑为 `*.example.com` 后保存；不会静默转换。后端升级需要重载插件或重启 DSH，使新的 `proxies` schema 生效，再刷新设置页使用新界面。本次没有自动重启或更改用户的代理配置。

### 保存提示 `Config field "proxies" is not volatile`

这表示当前运行后端没有把新 `proxies` 字段注册为可实时保存，常见于前端已更新、后端仍加载旧代码。仅刷新网页不会重载后端模块。新版客户端会检查宿主返回的可编辑字段；若明确缺少 `proxies`，在发起写入前拒绝，并给出后端重载提示；未提供 schema 的旧接口仍兼容尝试写入，但相同拒绝错误也会转为明确提示。

先自行记下未保存改动，再重载 M-H-Proxy **后端**；宿主不支持插件热重载时，用原启动方式重启当前 DSH 服务（可能中断其它会话／后台任务，需事先确认）。后端加载成功后，若页面仍保留草稿，点「重新读取并保留草稿」核对再保存；若整个页面已重新打开，则先核对保存值并重新应用记下的改动。客户端不会降级成旧单代理写入、不会清空旧配置绕过错误，也不会自动重启服务。

## 开发

```sh
npm install            # 或 pnpm install
npm test               # node --test，纯离线：本地 loopback 代理/源站 + 内存 dispatcher
npm run typecheck      # tsc --noEmit
npm run build          # host (lib/index.js) + client (lib/client.js) 双产物
npm run verify         # typecheck + build + test，与 CI、发布闸门同一套
```

测试只使用本地 loopback 与模拟对象，不访问真实模型 API、不需要代理或网络。`lib/` 与 `dist/` 是构建产物，不纳入版本控制。

发布走 `./deploy.sh release → build → publish`；已发布的版本不可重锁，`publish` 在 npm 已有同版本时会先核对本地产物与 npm 包的 SHA512 一致，再创建 GitHub Release。

## License

MIT（含源自 elizax/dsh-http-proxy 的 MIT 衍生部分，见 LICENSE）
