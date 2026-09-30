# Weave

一个会主动开启话题的本地 TypeScript 会话应用。预置成年龙娘「绯璃」：温和、好奇、有主见，喜欢故事、天气与日常小机关。人格必须由用户保存后才生效；首次设置不是一条聊天消息。

## 启动

要求 Docker（linux/amd64）；宿主截图要求 Linux X11、Node.js 22.13+、ffmpeg、xrandr。联网能力使用本机 DeepSeek Harness `dsh`。

```sh
cp .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY、CAPTURE_TOKEN（随机长串）。不要提交此文件。
docker compose up --build -d
```

未安装 Docker Compose 的机器可执行 `./scripts/run-local.sh`，同样构建并启动 amd64 容器；停止用 `docker stop weave`，数据目录保留。

打开 <http://127.0.0.1:4318>，检查并保存绯璃的人格。保持页面可见，约 10 秒后开始评估，目标 120 秒内显示具体话题。可用开关控制主动交流、截图及联网，或安静 30 分钟。

编译与单元/组件测试：

```sh
docker run --rm --platform linux/amd64 -v "$PWD:/app" -w /app \
  -u "$(id -u):$(id -g)" node:22.16.0-bookworm-slim \
  sh -c 'npm ci && npm run build && npm test'
```

## 宿主能力

完成上面的 Docker 编译后，宿主运行以下服务。使用 Docker 时，`CAPTURE_HOST`/`RESEARCH_HOST` 绑定 Docker 网桥地址，例如 `172.17.0.1`；`.env` 中 URL 对应 `http://host.docker.internal:4319` 和 `http://host.docker.internal:4321`。不同安装的网桥地址以 `docker network inspect bridge` 为准。纯宿主运行默认仅监听 `127.0.0.1`。

```sh
# 首次初始化 DSH 专用 profile（已有则省略本行；在项目外运行以免 DSH 读取 .env）
(cd /tmp && dsh --profile weave-research --from-default-profile headless --help)
CAPTURE_HOST=172.17.0.1 node --env-file=.env dist/host_capture/server.js
RESEARCH_HOST=172.17.0.1 node --env-file=.env dist/host_research/server.js
```

截图适配器只采集 X11 主显示器；不能由聊天文本扩大目标范围。打开截图时，真实图片会发送到配置的 DeepSeek 服务。图片与数据库保存在 `data/`，普通截图超过 24 小时且没有有效记忆引用时清理。

联网适配器调用独立 `weave-research` headless profile；`config/dsh/read-only.patch.yml` 关闭 shell、文件、工作流、子 Agent 等执行工具，仅保留网页搜索和读取能力，不修改已有 DSH profile。适配器使用 `RESEARCH_TOKEN`，未设置时复用 `CAPTURE_TOKEN`；可通过 `DSH_BIN` 指定本机命令。若宿主使用 Fake-IP 代理，启动查询适配器时显式导出 `HTTPS_PROXY` 和 `HTTP_PROXY`（例如 `http://127.0.0.1:7890`），由 DSH 的标准代理策略负责联网；不要把代理地址放进 DSH 自动读取的项目 `.env`。查询从独立临时目录运行，项目 `.env` 不作为 DSH 配置加载。密钥通过进程环境传递。

行为区可选择 `QUERY_WEATHER` 或 `SEARCH_STORIES`；真实结果带时间和来源回到感知区，再由思考和行为生成文本。天气地点需要用户明确给出；故事使用简短概述并附来源。一次唤醒最多执行一次外部查询或截图，后台联网查询最多 6 次/小时。网络失败不会被包装成查询成功。

## 验证

- `npm test`：人格门禁、LRU、归档恢复、三小时退避、上下文失效、来源保留、预算与 DSH 行为集成等组件测试。必须先在 Docker 中编译。
- `npm run acceptance`：真实 DeepSeek 文字开题（COMMITTED，不冒充浏览器显示）。
- `node dist/scripts/browser-acceptance.js`：10 次冷启动 + 10 次有历史样本，真实浏览器显示回执，核心服务在 Docker 中运行；宿主需 `npx playwright install chromium`。支持 `CHROMIUM_PATH`、`SAMPLES`、`BATCH`。
- `node dist/scripts/vision-acceptance.js`：真实截图和视觉链路。
- `node dist/scripts/research-acceptance.js`：真实 DSH 天气与故事查询链路。

测试数据库、截图、原始模型记录均在被 Git 忽略的 `artifacts/`。公开验收摘要见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。`data/` 是持久卷，重新构建容器不会删除人格、记忆和聊天。备份时停止服务再复制整个数据目录。

## 设计文档

[完整第一期设计方案](docs/design-v1.md)和[五区流程图](docs/assets/01-five-zone-flows.png)保留原始设计。实现以 TypeScript 替代原方案中的 Python，并按后续要求增加 DSH 天气/故事只读联网动作。图示源码在 `tools/render_diagrams.py`；重新绘制使用 `python3 tools/render_diagrams.py`（需 Matplotlib 与中文字体，可用 `WEAVE_CJK_FONT` 指定）。

## 结构

- `src/agents/`：感知、思考、行为、记忆、驱动五个逻辑区，各有收件队列与独立提示词。
- `src/runtime/`：契约、相关请求编号、模型并发/预算和调度。
- `src/storage/`：SQLite 事务、HOT/PENDING/长期记忆、话题、动作及显示回执。
- `src/adapters/`、`host_capture/`、`host_research/`：宿主能力与调用适配。
- `web/`：TypeScript 浏览器界面；`config/`：可编辑人格；`prompts/`：各区提示词。

单来源不调用感知模型，原样转发；多来源仅整合同一任务的关联输入。语言 `COMMITTED` 与浏览器 `DISPLAYED` 分开。人格版本、用户新输入和控制变化会使旧决策失效。LRU 不影响当前人格基础记忆；归档失败保留 PENDING，重新启动可继续处理。
