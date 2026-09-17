# ledger

个人记账本是一个本地优先的中文收支记录应用，适合自己部署、自己维护。它支持收支记录、筛选查询、统计图表、预算管理、偏好设置、标准 JSON/CSV 导入导出，以及支付宝 CSV、微信 XLSX 账单导入。

## 功能概览

- 收支记录：新增、编辑、删除、按日期/分类/标签/金额/备注筛选，筛选结果带收入/支出/结余汇总条，并可查看只读来源信息和导入批次。
- 统计分析：查看收支概览、等长上期变化、自然日日均、趋势图、分类排行和收入/支出标签排行。
- 预算管理：支持月度/年度预算，并按当前业务时区计算本月预算状态。
- 账单导入：支持标准 JSON/CSV、支付宝 CSV、微信 XLSX，导入前预览、重复识别、批次历史和一次性撤销。
- 完整备份：支持创建、下载、删除、上传恢复和列表恢复，并按业务时区每天 03:00 自动快照。
- 偏好设置：支持业务时区和界面主题设置。
- 登录鉴权：首次运行通过日志中的初始化 Token 创建唯一账户，之后用户名+密码登录，数据接口一律需登录访问。
- Docker 部署：GitHub Actions 构建镜像，Docker Compose 一键启动。

## 技术栈

- 前端：React 19、TypeScript、Vite 6、MUI 7、Zustand、Recharts、Axios、React Router 7
- 后端：Express 5、TypeScript、better-sqlite3、SQLite
- 测试：Jest、ts-jest、Playwright
- 部署：Docker、Docker Compose

## 快速开始

如果只是部署使用，推荐直接看“Docker 部署”。如果需要改代码、调试页面或运行测试，再看“本地开发”和“验证命令”。

## Docker 部署

在服务器或 NAS 上进入项目目录后执行：

```bash
docker compose pull
docker compose up -d
```

启动后访问：

```text
http://localhost:3000
```

如果是在局域网服务器上部署，把 `localhost` 换成服务器 IP，例如：

```text
http://192.168.31.254:3000
```

`docker-compose.yml` 默认使用镜像：

```text
ghcr.io/baoxinwen/ledger:latest
```

GitHub Actions 会在 `main` 分支推送后构建并发布这个镜像。容器内 Express 会同时托管前端构建产物和 `/api` 接口。SQLite 数据通过下面的挂载目录持久化：

```text
./data:/app/server/data
./backups:/app/server/backups
```

`./backups` 中的完整快照包含账户凭据哈希、设置和全部账本数据，未应用层加密。手动快照和恢复前安全快照不会被自动清理；自动快照保留最近 7 个，并额外保留最近 4 个自然周各自最新的一份。也可以通过 `LEDGER_BACKUP_DIR` 覆盖默认备份目录。

默认部署使用中国时区：

- `TZ=Asia/Shanghai`：容器系统时区，同时作为应用业务时区首次初始化默认值。
- 之后如果在设置页“偏好设置”中保存了时区，以设置页保存的值为准。
- 界面主题默认跟随系统，也可以在设置页切换为浅色或深色模式。

## 常用 Docker 命令

| 场景 | 命令 | 说明 |
| --- | --- | --- |
| 启动或更新后重启 | `docker compose up -d` | 后台启动服务。 |
| 查看日志 | `docker compose logs -f app` | 排查导入失败、启动失败、接口错误时最常用。 |
| 拉取最新镜像 | `docker compose pull` | 从 GitHub Container Registry 拉取最新镜像。 |
| 更新到最新镜像 | `docker compose pull && docker compose up -d` | 拉取镜像后重新创建容器。 |
| 停止服务 | `docker compose down` | 停止并删除容器，不删除 `./data` 数据。 |
| 本地临时构建镜像 | `docker build -t ledger:local .` | 用当前代码在本机打一个测试镜像。 |

## 登录与安全

应用默认开启登录鉴权：所有数据接口都需要登录后才能访问，未登录只能看到登录或初始化页面。

首次部署（或数据卷中还没有账户）时，启动后会在日志中输出一次性**初始化 Token**：

```bash
docker compose up -d
docker compose logs -f app
```

日志里会出现类似下面的横幅，把其中的 Token 复制到浏览器初始化页面创建账户：

```text
==============================================================
首次使用：请先创建你的登录账户
初始化 Token：xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
提示：Token 在创建账户后立即失效；创建账户前重启容器会重新生成
==============================================================
```

- Token 只用于创建账户，创建成功后立即失效；此后使用用户名 + 密码登录。
- 创建账户前重启容器会重新生成 Token，以最新一次日志输出为准。
- 会话有效期 30 天；退出登录后立即失效。
- 恢复完整备份后，所有现有会话都会失效，必须重新登录。
- 如果通过 HTTPS 反向代理访问，在 `docker-compose.yml` 的 `environment` 中增加 `COOKIE_SECURE=true`，让会话 Cookie 只走 HTTPS。
- 安全响应头的 CSP 中放行了 `https://static.cloudflareinsights.com`（Cloudflare 统计脚本）。如果你没有使用 Cloudflare Tunnel/统计，这个例外不会被触发；介意第三方域名的可以自行从 `server/src/app.ts` 中移除。
- 如果部署在 Nginx 等反向代理后，在 `docker-compose.yml` 的 `environment` 中增加 `TRUST_PROXY` 声明可信代理，让登录限流按真实客户端 IP 计数（否则同一代理 IP 会被当作同一来源合并限流）。推荐用反代层数（如 `TRUST_PROXY=1`）而不是 `TRUST_PROXY=true`：信任全部跳数时若 3000 端口可被绕过反代直连，攻击者能伪造 `X-Forwarded-For` 重置限流。也支持逗号分隔的可信代理 IP/网段。
- 登录与创建账户接口都有失败限流：同一来源连续失败 5 次会进入 15 分钟冷却期。
- 容器以非 root 用户（node，uid 1000）运行；数据目录属主由容器 entrypoint 在启动时自动修正，从旧版本升级无需手动 `chown`；entrypoint 以 `umask 077` 运行应用，账本、备份等文件仅属主可读写。

忘记密码：目前没有内置找回。需要停止服务后，用 SQLite 工具删除挂载卷 `./data/ledger.db` 中 `users` 和 `sessions` 表的数据，重启后应用会重新进入初始化流程。

本地开发同样需要先创建账户；调试时若想跳过登录，可在启动后端前用 `SETUP_TOKEN` 固定初始化 Token（仅非生产环境生效）。

## 本地开发

本地开发需要分别启动后端和前端，建议打开两个终端窗口。

后端：

```bash
cd server
npm install
npm run dev
```

后端默认监听：

```text
http://localhost:3000
```

前端：

```bash
cd client
npm install
npm run dev
```

前端默认监听：

```text
http://localhost:5173
```

开发环境下，Vite 会把 `/api` 请求代理到后端 `http://localhost:3000`。所以本地调试页面时访问前端地址 `http://localhost:5173`。

## 验证命令

“验证命令”是给开发和提交代码前用的，用来确认代码没有明显坏掉。只用 Docker 部署时，通常不需要运行这些命令；部署排错优先看：

```bash
docker compose logs -f app
```

推荐提交前按这个顺序验证：

```bash
cd server
npm test
npm run build
```

```bash
cd client
npm test
npm run build
```

如果这次改动涉及页面交互，再额外运行：

```bash
cd client
npm run test:e2e
```

每条命令的含义如下：

| 命令 | 什么时候运行 | 检查什么 |
| --- | --- | --- |
| `cd server && npm test` | 改了后端逻辑、导入解析、预算、设置、数据库时运行 | 运行 Jest 单元测试，确认后端核心逻辑符合预期。 |
| `cd server && npm run build` | 改了后端 TypeScript 文件后运行 | 检查后端能否编译到 `server/dist`。 |
| `cd client && npm test` | 改了前端交互、store 或工具函数后运行 | 运行 Vitest 组件和逻辑测试。 |
| `cd client && npm run build` | 改了前端页面、组件、store、工具函数后运行 | 检查前端 TypeScript 和 Vite 生产构建是否通过。 |
| `cd client && npm run test:e2e` | 改了页面交互、布局、路由、导入导出界面时运行 | 启动 Playwright 浏览器测试，验证真实页面交互。e2e 自包含运行：会自动启动隔离后端（18088 端口，避开 Windows 常见保留端口段、临时数据库、已知初始化 Token）和前端（6080 端口），不依赖你手动开启服务。 |

常见现象：

- `npm run build` 只要最后显示成功，就算通过。
- Vite 提示 `Some chunks are larger than 500 kB` 是体积警告，不是构建失败。
- Playwright 需要能启动浏览器；如果本机权限限制浏览器启动，可能会出现 `spawn EPERM`。
- 如果只改 README 这类文档，一般不需要跑测试。

## 账单导入规则

- 标准导入：支持现有 JSON/CSV 格式；JSON/CSV 是便携业务数据导出，不具备完整恢复语义。
- 支付宝导入：支持官方导出的交易明细 CSV，自动跳过说明区并读取 `交易时间,交易分类,...` 表头后的记录。
- 微信导入：支持官方导出的支付账单 XLSX，自动读取首个工作表中的账单明细。
- 现金流规则：只导入 `收入` 和 `支出`；跳过不计收支、中性交易、关闭、失败或取消状态；退款按账单中的收入行导入。
- 去重规则：平台订单号属于硬重复并始终跳过；无订单号时按类型、金额分、日期、分类、备注和排序后标签生成内容指纹，确认前可选择包含内容重复。
- 分类规则：按平台原始分类/交易类型自动创建自定义分类，并保留原始分类、支付方式、交易状态等元数据。
- 撤销规则：导入批次可以撤销一次，批次内交易即使后来编辑过也会删除；由该批次创建且已无引用的分类和标签会一并清理。
- 字段上限：与手动创建接口一致——备注不超过 2000 字符，分类、标签不超过 64 字符，来源元数据字段（交易单号、支付方式等）不超过 200 字符，金额上限 10^12 且最多两位小数；超限记录在预览中标为"失败"并给出原因，不会静默截断。

## 提交和镜像发布

当前仓库推送到 `main` 后，GitHub Actions 会构建 Docker 镜像并发布到：

```text
ghcr.io/baoxinwen/ledger:latest
```

服务器使用 Docker Compose 部署时，更新流程通常是：

```bash
docker compose pull
docker compose up -d
docker compose logs -f app
```

## 许可证

本项目基于 [MIT](LICENSE) 许可证开源。
