# dsh-model-http-proxy

给 DeepSeek Harness（DSH）加「**模型 API 按提供方精准走代理，其余请求直连**」的能力，不修改任何 DSH 官方代码。

不开系统全局代理的前提下：某个模型的 API 访问不了、但代理服务器能访问时，只让**这个模型的请求**走代理；web 搜索、网页抓取、MCP、其它所有模型与请求照旧走本机直连，互不影响。

> **状态**：v0.1.x 可用版。设置页已经在 DSH 左栏「设置 → M-H-Proxy」里，域名列表以标签形式管理，下拉只列出**当前激活的提供方**。
>
> **血统与致谢**：本项目的 fetch 路由地基源自 [elizax/dsh-http-proxy](https://github.com/elizax/dsh-http-proxy)（MIT，自 0.1.3 起未再维护、不适配 DSH 0.1.7+），在其基础上适配了 0.1.7+ 的 settings 架构并持续演进。感谢原作者。

## 功能

- **自动模式**（默认）：自动识别所有已知模型 API 域名（官方 DeepSeek、`DEEPSEEK_BASE_URL`、全部 `llm-pi-ai` 提供方网关），统一走代理；其它流量直连
- **手动模式**：只代理你列出的域名/后缀，其余（含模型 API）全部直连
- **排除名单**：优先级最高，命中的域名永不走代理
- **首页式设置页**：域名以标签呈现（× 一键移除、回车/逗号确认），两栏互斥——已经出现在「只代理这些域名」的不会再出现在「排除域名」的下拉里，反之亦然
- **下拉只列激活的提供方**：从宿主的模型目录（`session.modelCatalog`）读取当前真正可路由的 provider（含 Codex 订阅这类由插件注册的 provider），不是把内置目录全量倒出来；每行标注它属于哪个提供方
- 支持代理协议：`http / https / socks4 / socks4a / socks5 / socks5h`
- 设置改动下一次请求即生效：宿主侧读的是设置文档的实时值（不是启动时的快照），保存后 `globalThis.fetch` 的路由集合随之刷新，无需重启

## 路线图（v0.2+，本仓库的差异化方向）

- **按提供方路由**：规则直接写提供方名（如 `kimi-coding → 代理A`、`deepseek → 直连`），插件读取 `llm-pi-ai` 配置自动解析提供方 → 网关域名，不再需要手抄 hostname
- **多命名代理**：同时配置多个代理（socks5-A / http-B / ...），不同提供方走不同代理
- 连通性测试按钮、每提供方的实际路由状态展示

## 安装

```sh
dsh plugin --profile web add dsh-model-http-proxy
```

> **兼容性**：需要提供 `settings.section` 槽位与 `remote.settings` 面（0.1.7+）；设置页不依赖宿主 primitives 的图标导出，因此跨版本不会再因图标改名而白屏。已在 0.2.1-rc.2 真机验证。

## 使用

1. 打开 DSH **设置（左栏）→ M-H-Proxy**
2. 填入代理地址（如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:7890`），保存
3. （可选）在「只代理这些域名 / 排除域名」里加域名：从下拉挑激活的提供方，或直接输入域名 / `域名:端口` / URL / `.域名后缀`

两种模式的区别：**「只代理这些域名」留空 = 自动模式**（所有模型域名走代理，排除名单生效）；**填了就是手动模式**（只有列出的域名走代理，排除名单此时基本是冗余的）。

改完下一次请求生效。

## 开发

```sh
npm install          # 或 pnpm install
npm run typecheck    # tsc --noEmit
npm run build        # host (lib/index.js) + client (lib/client.js) 双产物
```

## License

MIT（含源自 elizax/dsh-http-proxy 的 MIT 衍生部分，见 LICENSE）
