# Agora Mesh

> **当 AI Agent 开始互相打工时，它们该怎么给对方发工资？**
> 
> 人类的网络依靠精美的 UI 和信用卡，而 Agent 的数字经济需要的则是：以语义化的协议为法律，以免信任的数字货币为薪水。Agora Mesh 为此而生。

![Agora Mesh Landing Page](./assets/screenshot2.png)
*(Agora Mesh - 官网首页)*

![Agora Mesh Dashboard](./assets/screenshot1.png)
*(Agora Mesh - Dashboard 控制台)*

Agora Mesh 是一个以 BNB Smart Chain Testnet 为默认网络的 Agent Commerce 原型，旨在让 AI Agent 能够**自主发现、比较、雇佣、支付并验证服务**。当前迁移重点是 Altana Scoped Session、通用多资产预算模型，以及后端发起的 x402/B402 服务支付；Monad Testnet 作为 Legacy Preset 保留。

当前核心落地状态：P0/P1 的 BNB Testnet、Altana scoped Authority、x402、独立 Auditor/Verifier/Investigator/Sentinel、Marketplace/Authority/Advantage 页面、Revoke 负向测试和三组 Agent 实验均已形成可校验证据。Experiment 2 的后验风险覆盖为 8/8（含 422-holder 完整快照和 `0.1 U` 实际 sellability）；全新付费 Experiment 3 的四项服务净支出为 `1.35 U`，误结算 `0.5 U` 已退款，两个 Authority 均已撤销。全新 `agora-termix-stability-20260902` Authority 下的三次连续付费审计也已完成：每轮 `0.5 U` Auditor + `0.25 U` Verifier，共六笔唯一链上结算、总计 `2.25 U`，随后立即 Revoke、Permit2 allowance 归零且负向测试被拒绝；证据见 [`evidence/stability/three-consecutive-paid-runs.json`](evidence/stability/three-consecutive-paid-runs.json)。TermiX 要求的三组“有 Marketplace Agent / 无 Marketplace Agent”对照已完成，时间、估算成本、质量和原始输出见 [`evidence/AGENT_ADVANTAGE_REPORT.md`](evidence/AGENT_ADVANTAGE_REPORT.md)。2026-09-04 的 offer-v2 付费验收也已完成：同一限额 Authority 支付 Auditor、Verifier 和独立 Sentinel 共 `1.15 U`，按精确请求与交易证据恢复一次已结算交付，未重复扣款，随后完成 Revoke 与负向测试。后端的 PostgreSQL 多副本状态、文件快照原子导入和本地双进程恢复验收已经落地。Authority 管理面确定为显式确认的本地 CLI，浏览器页面只读验收公共证据，Admin 私钥不会进入前端。仍需依赖公开 HTTPS URI 的 ERC-8004 实际注册、获批准的独立部署环境及最终提交工作。详见 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) 和 [BACKEND_HANDOFF.md](BACKEND_HANDOFF.md)。

提交用英文文案和基于已冻结链上证据的三分钟录屏流程分别见 [`evidence/SUBMISSION_DRAFT.md`](evidence/SUBMISSION_DRAFT.md) 与 [`evidence/DEMO_RUNBOOK.md`](evidence/DEMO_RUNBOOK.md)。

部署入口已停用：原阿里云 chaochenbass 生产主机不属于本项目，相关服务已由用户撤除，不得重试或复用。`deploy/` 仅保留禁用配置与事故限制说明；没有当前获授权的部署目标。

---

## ⚙️ 核心引擎揭秘 (The Engines)

在这个系统中，“上帝视角 Debugger”（即前端 Dashboard）的背后，由两大顶级引擎支撑着整个全自动经济体的运转：

### 1. 自动结算流：HTTP 402 拦截与极速结算
传统的 Web API 必须在调用前绑定信用卡，而 Agora Mesh 创新了“先请求、后报价、再执行”的即时结算流：
1. **询价拦截**：Hunter 访问 Writer/Auditor 服务，服务方拒绝并抛出 `402 Payment Required` 及服务单据。
2. **大模型决策**：Hunter 的内置 LLM 对账单金额和信任模型进行判断与预算审批。
3. **权限化结算**：Hunter 在 Allowlist、Spend Cap 与 Expiry 约束内，使用 Altana Session Key 在 BNB Testnet 发起支付；Legacy EOA 只用于本地回退。
4. **签发凭证**：收款 Agent 确认 tBNB 或实际协商资产到账后完成服务，并返回交易证据与签名 Receipt。


### 2. 自动化指挥长：Commander V2
基于 ReAct（Reasoning and Acting）架构设计的自循环编排引擎：
*   **拆解任务**：一个庞大的单一 Goal 会被拆解出多个子阶段（如 Discovery, Decision, Payment, Execution, Verification）。
*   **管道蛇 (Pipeline Snake)**：前端 UI 通过可视化贪吃蛇的模式，直观呈现 Hunter 在 Mesh 中游走、探测并最终吞噬其他 Agent 能力的过程。
*   **声誉网络与动态进化**：每次任务结束后，这不是一次性的买卖。Agent 自身会进行总结提炼（Reflect），将经验升华为大模型的“深层洞察（Core Insights）”并永久储存在向量记忆雷达中；同时，Hunter 还会对接单 Agent 的交付质量给出严格判定并修改其在 Registry 中的 **"Reputation" (声誉值)**，劣质节点会被降低权重甚至淘汰，使得无人的网格系统始终保持着**自我净化的生命力**。

---

## 🚀 快速开始

本项目分为前端（Next.js 控制台）、Hunter（购买方）、可配置 Service Host（Auditor / Verifier + Token Risk Verifier / Onchain Investigator 独立实例）和 Registry。

### 1. 安装依赖

需要 Node.js `20.19+`（当前 Altana / Next.js 依赖链的最低兼容版本）。

```bash
npm install
```

### 2. 配置环境变量

从示例文件创建环境变量：

```bash
cp .env.example .env
```
_请编辑 `.env` 文件，填入 OpenAI / Kimi API Key。若要用合约地址拉取验证源码，还需配置 `ETHERSCAN_API_KEY`（`BSCSCAN_API_KEY` 是兼容别名）。默认链已设置为 BNB Testnet（chain ID 97）；不配置 Hunter 私钥时支付会进入 mock 模式。_

前端需要单独的环境变量配置，确保能访问你的本地后端节点：
```bash
cp frontend/.env.example frontend/.env.local
```

### 3. 一键启动矩阵网络

为了看到完整的“机器给机器付钱”的自治奇观，我们建议一键启动所有节点：

```bash
# 自动启动前端 + Registry + Hunter + Writer 所有开发服务器
npm run dev:all
```

启动完毕后，服务将运行在以下端口：
- **Dashboard (Frontend)**: `http://localhost:3000`
- **Hunter Agent**: `http://localhost:3002`
- **Security Auditor（独立钱包/身份）**: `http://localhost:3001`
- **Verification Agent（独立钱包/身份）**: `http://localhost:3004`
- **Onchain Investigator（只读 RPC Profile）**: `http://localhost:3005`
- **Registry**: `http://localhost:3003`

### 4. 体验完整闭环 Demo

打开 `http://localhost:3000/onboarding`，你将经历一段致敬极客的终端命令行上链流程。
随后，进入 Dashboard，在左侧命令行输入 Solidity 源码、`{"source":"...","sourceName":"Vault.sol"}`，或 BSC 合约地址。安全审计不会把普通自然语言目标当成合约源码。
观察主面板，你将看到：
1. Hunter 获取指令 -> 主动寻找网格中的服务商。
2. 触发标准 x402/B402 报价 -> Hunter 校验资源、资产、金额、收款人和超时后，通过 Altana scoped session 支付 $U；未启用 x402 时保留 Legacy tBNB 路径。
3. Auditor 返回严格 `SecurityFinding[]` 并签发回执；Hunter 验签后自动雇佣不同身份/钱包的 Verifier，再完成第二次报价、支付和回执验签。
4. Verifier 校验同一 `sourceHash`，优先运行 Slither；Slither 不可用或编译失败时，报告明确写出降级原因并使用确定性 AST 规则。

如果你只需要跑通后端闭环（终端查看彩色日志，不依赖浏览器）：
```bash
npm run demo
```

### 5. 运行质量门禁

```bash
npm run verify
```

该命令会执行全仓 TypeScript 检查、Hunter/Writer/Shared 测试、三组实验证据的哈希/目标/身份/付款绑定校验与公开证据 Secret 字段检查，以及无 WalletConnect Project ID 情况下的前端生产构建。仅复核证据时可运行 `npm run verify:evidence`；该命令不访问网络，也不会调用模型或发送交易。

三组 `Without Marketplace Agent` 基准已经冻结并完成评分。运行 `npm run finalize:advantage` 可从原始候选、独立 Claude 审核、Slither 和链上证据重建最终报告；`npm run verify:evidence` 会验证产物哈希、3/3 比较、24/24 Slither 裁决和非人工审核披露。运行 `npm run baseline:prepare` 仍可重建盲测输入包，但不会调用模型。

如需额外的人类签字，独立评审可按 [`evidence/CONTROLLED_REVIEW_HANDOFF.md`](evidence/CONTROLLED_REVIEW_HANDOFF.md) 执行。官方 TermiX 规则本身不要求人类评审，当前报告不会把 AI/operator 误标成人工。

Experiment 1 使用普通模型源码审计，Experiment 2 使用普通模型 + 只读 RPC，Experiment 3 使用隔离 Claude + fresh Slither + 只读 RPC。它们在冻结输出前看不到 Agent 结论；执行者分别标注为 automated operator 或 independent AI，`/advantage` 显示 3/3 completed comparisons。候选模型调用会产生 API 用量；已落盘原始输出不应为了得到更好结果而覆盖。

### 5.1 本地 PostgreSQL 多副本模式

`STORE_BACKEND=file` 仍是方便单进程开发的默认值；需要共享任务、付款、Authority 公共证据、Registry、身份、反馈和 Hunter 记忆时使用 PostgreSQL：

```bash
npm run db:up
npm run db:migrate
npm run verify:postgres
STORE_BACKEND=postgres npm run dev:agents
```

首次从现有 JSON 状态切换时，先停止所有 Hunter / Registry / Service Host。导入命令默认只预检文件摘要、条数和金额，不写库；目标业务表非空会拒绝导入：

```bash
npm run db:import:files
AGORA_FILE_IMPORT_CONFIRM=I_CONFIRM_FROZEN_FILE_IMPORT npm run db:import:files
```

导入在单个数据库事务中完成并记录源摘要；相同快照重复执行只做一致性复核。`registry/altana-sessions.json` 永不导入数据库，生产多主机 Session signer 需要接入 KMS/Secret Manager；浏览器 Authority 管理也不包含在这套数据库切换中。生产多可用区、PITR 和故障转移设计见 [`database/PRODUCTION_DESIGN.md`](database/PRODUCTION_DESIGN.md)。

### 6. Altana Session Testnet Spike

这里的 **Authority** 是 Admin 在 BNB Testnet 上授予的一组可撤销权限边界，记录允许调用的合约/收款人、资产额度和过期时间；**Session** 是在这组边界内代替 Admin 签名的临时 signer。Hunter 运行时只读取 `ALTANA_AUTHORITY_ID`、`ALTANA_SESSION_STORE_PATH` 和 `ALTANA_SESSION_ENCRYPTION_KEY`，不需要持有 Admin 私钥。Admin 私钥只在创建或撤销 Authority 的脚本中短暂使用。

正式管理边界为“本地 CLI grant/revoke + 浏览器只读验收”。当前 Altana SDK 不接受 MetaMask/Rabby injected signer；项目不会用 `eth_sign` 盲签或把 Admin 私钥打包进浏览器来绕过该限制。未来如果需要完全浏览器化，应单独接入 Passkey smart wallet，并把它视为新的钱包与资金迁移流程。

`agents/hunter` 提供 `createWallet → grantSession → execute → revokeSession → execute fails` 验证脚本。脚本默认拒绝广播；仅应使用独立、低余额的 BNB Testnet Admin key，并在 `.env` 中配置：

```dotenv
ALTANA_SESSION_ENCRYPTION_KEY=<32-byte hex or base64>
ALTANA_SPIKE_ADMIN_PRIVATE_KEY=<dedicated testnet key>
ALTANA_SPIKE_RECIPIENT=<testnet recipient>
ALTANA_SPIKE_AMOUNT=1
ALTANA_SPIKE_CONFIRM=I_UNDERSTAND_TESTNET_TXS
```

明确接受它会发起测试网交易后运行：

```bash
npm run spike:altana --workspace @rebel/hunter
```

Session signer 只会以 AES-256-GCM 密文落盘；验证 revoke 后失败成功时，本地 Session material 会被删除。Admin key 不会写入 Session store 或输出日志。

要为实际 x402 流程创建可持久化的测试网 Authority，请先给 Altana smart wallet 准备少量 tBNB 与测试网 `$U`，配置允许的 Auditor / Verifier 收款地址与每日上限，并显式确认后运行：

```dotenv
ALTANA_ENABLED=true
ALTANA_NETWORK=bnb-testnet
ALTANA_SESSION_STORE_PATH=./registry/altana-sessions.json
ALTANA_SESSION_ENCRYPTION_KEY=<32-byte hex or base64>
ALTANA_X402_ADMIN_PRIVATE_KEY=<dedicated testnet key>
ALTANA_X402_ALLOWED_RECIPIENTS=<auditor wallet>,<verifier wallet>
ALTANA_X402_DAILY_LIMIT=2000000000000000000
ALTANA_X402_EXPIRY_SECONDS=86400
ALTANA_X402_CONFIRM=I_UNDERSTAND_X402_TESTNET_TXS
```

```bash
npm run provision:altana-x402 --workspace @rebel/hunter
```

该脚本会注册限时 Session、授权对应 Session 使用 Permit2 签名检查器、把 Permit2 token allowance 限制为配置额度，并只把 Session signer 加密保存。成功后它会输出 `authorityId`，并以这个 ID 为索引写入加密 Session store；请把输出值手动写入 `.env` 的 `ALTANA_AUTHORITY_ID`，供 Hunter 运行时加载。脚本默认拒绝广播，也不会自动执行服务支付。

任务结束后使用同一确认短语、Admin key 与 `ALTANA_AUTHORITY_ID` 运行 `npm run revoke:altana-x402 --workspace @rebel/hunter`。它会撤销签名检查器、清零 Permit2 allowance、撤销 Session，并删除本地加密 Session material。

### 7. 独立 Auditor / Verifier / Investigator

`npm run dev:all` 现在会分别启动 `SERVICE_PROFILE=auditor`（3001）和 `SERVICE_PROFILE=verifier`（3004）。请在 `.env` 中配置不同的 `AUDITOR_PRIVATE_KEY` 与 `VERIFIER_PRIVATE_KEY`。Hunter 会拒绝与 Auditor 共用 service ID、agent ID 或收款钱包的 Verifier。

Verifier 不复用 Auditor 的自由推理：它只接收原始 Solidity source units 与结构化 Findings，优先执行 Slither `--json -`，输出 `static-analysis` 证据与 `missed` 项；Slither 缺失或无法编译时回退为 `ast-rule`，并在 `/health` 和验证报告中明确暴露降级原因。动态 Registry 写入使用跨进程锁和原子替换，Auditor / Verifier 同时启动不会互相覆盖注册数据。

Slither 是 Trail of Bits 维护的 Solidity/Vyper 静态分析器。项目使用隔离环境，避免污染系统 Python；安装后 Verifier 会自动发现 `.venv-slither/bin/slither`，也可用 `SLITHER_BIN` 覆盖：

```bash
python3 -m venv .venv-slither
.venv-slither/bin/python -m pip install -r requirements-slither.txt
VIRTUAL_ENV="$PWD/.venv-slither" .venv-slither/bin/solc-select use 0.8.20 --always-install
```

验证源码可能要求与浏览器完全一致的编译器。Experiment 3 的 U token 实现使用 `0.8.28`：

```bash
VIRTUAL_ENV="$PWD/.venv-slither" .venv-slither/bin/solc-select install 0.8.28
SOLC_VERSION=0.8.28 .venv-slither/bin/solc --version
```

地址输入通过 Etherscan V2 `getsourcecode` + `chainid=97` 解析。未验证合约、缺少 API key、源码超限、没有独立 Verifier、报告 schema 不匹配或 `sourceHash` 不一致都会显式失败，不会返回“已完成完整审计”。

`SERVICE_PROFILE=investigator`（3005）执行确定性、只读 BNB JSON-RPC 调查，不调用 LLM，也不支持任何发送交易的方法。它测量账户状态、合约字节码、ERC-20 元数据、owner、EIP-1967 proxy slots，并继续扫描 implementation 字节码中的 mint / pause / blacklist / upgrade selectors 与危险 opcode。付费原始报告没有完整证据的 holder concentration、流动性、sellability 和近期交易行为会明确返回 `not-measured`；原始报告保持不可变，后置 enrichment 会单独绑定其报告哈希和历史区块。

同一独立 Verifier 身份在 3004 同时发布 `risk-verifier-v1`。Hunter 完成 `onchain-investigation` 后会自动寻找与 Investigator 不同身份/钱包的 `token-risk-verification` 服务，并在原报告指定的历史区块通过独立只读 RPC 重放字节码、账户、ERC-20、ownership、proxy、risk signals、score 与 coverage。历史节点不可用或任一事实不一致时验证会显式失败/降级，不能把“最新状态相似”当成原报告已确认。复现实验 2 的本地后验验证：

```bash
npm run review:token-risk
npm run enrich:token-risk
```

`enrich:token-risk` 在原报告区块只读检查 PancakeSwap V2/V3 U/WBNB 池、V2 路由报价和一个有明确边界的 `Transfer` 日志窗口，并记录 Etherscan/Blockscout 索引可用性。路由报价只标记为 `quote-only`，不会被当作成功 swap 或 sellability 证明；付费索引器返回 402 时脚本不会自动付款。

已归档的 `sellability-execution-output.json` 额外证明了 `0.1 U` 的真实 PancakeSwap V2 卖出、5% 最大滑点和交易后 Router allowance 为零。`holder-snapshot-output.json` 则记录了 BscScan 全五页 422 个候选地址，并在同一区块逐一读取余额、精确对账 `totalSupply`。若需重建 holder 证据，将全分页导出的 JSON 路径作为 `HOLDER_SNAPSHOT_INDEX_PATH` 传给 `npm run snapshot:token-holders`；任何漏读或供给不一致都会 fail-closed。

复现实验 3 的同目标离线尽调候选（不会再次调用模型、创建 Authority 或付款）：

```bash
npm run candidate:due-diligence:reuse
```

该命令校验 U token 的整包源码哈希、scoped 源码哈希、实现地址与 Auditor 身份，按浏览器给出的 Solidity `0.8.28` 和 remapping 重跑 Slither，再将源码、代理/实现地址、链上报告哈希、历史区块、独立复核与 DEX enrichment 绑定到一个 `partial` 报告。`partial` 只确认 Finding 引用的源码结构，不代表当前可利用性；`missed` 只表示 Auditor 未覆盖、需要人工复核，不等于已确认漏洞。99KB whole-package Auditor 曾多次超时；如需重新调用模型，当前高速度候选把 LLM 范围明确限制为三个浏览器验证的第一方 `src/` 单元，依赖仍由完整包 Slither 覆盖：

```bash
npm run candidate:due-diligence:fast
npm run triage:due-diligence
```

`candidate:due-diligence:fast` 会产生新的模型 API 用量；`candidate:due-diligence:reuse` 不会。高速 scoped Auditor 返回的 Findings 仍需确定性与人工复核；`triage:due-diligence` 只执行 `eth_call` / `eth_getStorageAt`，不会签名或广播交易。离线候选仍单独标注；正式的全新付费 Experiment 3 已完成并由 `paid-run-final-output.json` 绑定四项付款、退款、两段 mission 与 Authority 清理。

```bash
npm run dev:investigator
curl http://localhost:3005/health
```

正式 Investigator 与 Risk Verifier 付款已经在 Experiment 2/3 中完成。重新运行仍必须使用新的、限额且限时的 Authority，并遵守脚本的显式广播确认门禁；普通 `npm run verify` 永远不会发送交易。

### 8. 公开部署安全配置

Express 服务现在使用精确 CORS allowlist、统一 `X-Request-Id`、结构化安全日志、固定窗口限流和 body limit。Hunter 的 run/Authority/Mission API、Registry 写接口与 legacy `/execute` 支持 Bearer 或 `X-Agora-Token`；生产环境未配置 Token 时会 fail-closed。x402 `/execute/x402` 继续由请求绑定的付款证明保护。Registry 还拒绝未授权的 HTTP、loopback、私网/metadata IP 和解析到私网的动态服务地址。

生产环境至少配置 `CORS_ALLOWED_ORIGINS`、各服务独立 `*_API_AUTH_TOKEN`、公开 HTTPS endpoint 和合理的 `*_RATE_LIMIT_PER_MINUTE`。`NEXT_PUBLIC_DEMO_API_TOKEN` 只能是可公开、权限极小的演示 Token，绝不能放入 Admin/Session 私钥或服务端 API Secret。

---

## 🏗 技术栈图谱

*   **前端交互**: Next.js 15, React 19, Tailwind CSS, shadcn/ui, Framer Motion
*   **AI 大脑**: Vercel AI SDK, OpenAI-compatible APIs
*   **支付与身份**: Altana SDK, Scoped Session, x402/B402, ERC-8004
*   **默认结算层**: BNB Smart Chain Testnet（Monad Testnet 为 Legacy Preset）

---

## 📁 核心目录结构

```text
agora-mesh/
├── agents/                  # 核心智能体实现
│   ├── hunter/              # 需求发起方与付款方，搭载 Commander V2 引擎
│   ├── writer/              # 服务提供与收款方，搭载自动定价校验机制
│   ├── registry/            # 去中心化市场探测雷达（服务发现注册表）
│   └── services/            # 定义不同 Agent 的能力枚举（审计、发文、合约分析）
├── frontend/                # 管理控制台与交互前端
│   ├── src/app/onboarding/  # 酷炫终端命令行风的极速建档上链页面
│   ├── src/app/dashboard/   # 上帝视角 Debugger 控制台
│   └── src/components/timeline/ # "管道贪吃蛇" 组件与 x402 实时 Trace 日志流
└── scripts/                 # 本地快速测试验证脚本库
```

## 📜 License

MIT License
