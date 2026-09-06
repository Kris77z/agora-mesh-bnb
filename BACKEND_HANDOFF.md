# 后端交接与恢复说明

更新：2026-09-04。后端 offer-v2 / Authority lifecycle 已完成一轮新的 BNB Testnet 付费验收；未部署任何服务器，严禁使用已移除的阿里云目标。

## 接口边界

| 服务 | 接口 | 前端应如何处理 |
|---|---|---|
| Hunter :3002 | `GET /authority` | 读取 authority、spending、revocation、lifecycle；invalid/blocked 不允许再提交付款 |
| Hunter | `POST /run`、`GET/POST /run/stream` | 必须提供 `Idempotency-Key`（SSE GET 用 `idempotencyKey` 查询参数）；相同键和输入只执行一次，响应带 `X-Mission-Id`；此操作可能在有效授权内花费 U |
| Hunter | `GET /runs/:missionId`、`POST /runs/:missionId/cancel` | 查询持久运行状态或显式取消；断开 SSE 只停止观看，不会把可能已付款的任务误当成已取消 |
| Hunter | `GET /missions`、`GET /missions/:missionId` | 查看持久化任务；不能将找不到结果理解成未付款 |
| Hunter | `GET /advantage` | 冻结实验和测量结果，不触发新的实验 |
| Registry :3003 | `GET /services`、`GET /services/:serviceId` | 展示目录，可含历史/Legacy seed，不代表全部可付款 |
| Registry | `POST /services/compare` | x402 模式使用当前有效身份探测和同一支付兼容策略；响应包含 policy；可能只有一个或零个候选 |
| Service Host | `GET /identity` | services[] 是完整能力清单，service 是首项；Verifier 同时提供 Finding Verifier 和 Risk Verifier |
| Service Host | `POST /execute/x402?requestHash=…` | 无签名首次返回 402；已付款原单无签名重放返回结果或继续执行，不再次结算 |

Hunter 受保护接口沿用现有 Bearer / X-Agora-Token 认证。不要把管理钱包私钥、Session Key 或服务商 facilitator key 放进浏览器。此版本没有可直接广播的 HTTP grant/revoke 接口。

任务在任何服务发现或付款前先把 missionId、输入指纹和幂等键哈希写入所选 Store；file 模式使用 `registry/runs.json`，postgres 模式使用 `runs/run_idempotency/run_events`。原始幂等键不落盘。SSE 事件有单调 `id`，浏览器断线后携带 `Last-Event-ID` 重连，同一键只回放同一任务。PostgreSQL 模式下过期 lease 可由另一副本接管且旧 fencing token 不能再写；file 模式重启遇到 running 则 fail-closed。取消不撤回已提交的链上签名或结算，仍需检查 x402 journal。

## 新支付协议：offerVersion=2

1. 请求哈希覆盖任务、服务、链、输入、报价版本、随机 paymentNonce、金额、币种、收款方、时间和路径。
2. body.paymentNonce 是请求盐；实际签名的 Permit2 nonce / EIP-3009 nonce 使用 requestHash，不能继续使用 SDK 默认随机 nonce。
3. 签名截止时间必须等于请求 expiresAt，金额必须精确相等，不接受超额支付。
4. 服务端在任何结算前校验以上绑定，并将结算 intent 持久化。402/超时不自动等同于未转账。
5. 新 Receipt 使用 agora-request-result-v2，签名覆盖 requestHash、resultHash、provider 和 timestamp。历史未标记的收据只验证旧的结果签名；旧证据未被改签。

升级时应在没有运行中付费任务的情况下统一重启本地 Hunter 和 Service Host，再确认 identity.offerVersion。当前旧进程不会因文件修改自动升级。旧已付款请求仍可从原商户存储中重放；旧未付款报价不能用于 v2 新结算。本轮没有重启或关闭用户正在运行的服务。

## 不确定付款：查原单，不新开单

- 商户 SETTLEMENT_UNCERTAIN：请求可能已上链。保留 requestHash、idempotencyKey 和任务记录，不删除账本来重试。
- Hunter 原请求 journal：file 模式为 `registry/x402-purchases/` 的 0600 文件，postgres 模式为 `x402_purchases`；都只存原请求/报价和服务快照，不存支付签名或私钥。
- 同一 missionId + serviceId 重试使用原请求做无签名查询；修改输入会报 X402_PURCHASE_CONFLICT，不会偷偷生成新支付。
- 已确认付款但模型失败：直接重放原请求；后端只重试执行。
- 完全未发出的付款也可能因提前持久化 intent 而被保守拦住。没有可证明的结果时宁可人工对账，不自动清空状态。

新增对账命令（读取链、修改当前 `STORE_BACKEND` 的 journal，不广播、不调用 LLM）：

```bash
SERVICE_PROFILE=auditor \
X402_RECONCILE_CONFIRM=I_CONFIRM_LOCAL_SETTLEMENT_RECONCILIATION \
X402_RECONCILE_IDEMPOTENCY_KEY="填入原幂等键" \
X402_RECONCILE_TX_HASH="填入已确认交易哈希" \
X402_RECONCILE_PAYER="填入付款钱包地址" \
npm run reconcile:settlement --workspace @rebel/writer
```

选择实际收款 Service Profile。对账会校验原请求哈希、正确链、交易成功、facilitator、Permit2/EIP-3009 calldata、requestHash nonce、币种/金额/收款方/截止时间，以及唯一 Transfer。仅有“同金额转账”不够。完成后重放原请求取结果。

如果进程在 attempting 阶段崩溃，必须先确认相关 worker 已停止，再额外设置 X402_RECONCILE_WORKER_STOPPED=I_CONFIRMED_WORKER_IS_STOPPED。该标记是操作者的明确声明，工具不会擅自杀进程。此对账仅适用于新的 v2 请求；不要用历史 Transfer-only 恢复脚本处理新的不确定付款。

## Authority 生命周期

- 正式管理面是显式确认的本地 CLI，继续使用现有 EVM Admin 钱包；浏览器 `/authority` 只读展示公共状态和交易证据。当前 Altana SDK 不接受 injected signer，不使用危险的 raw-sign 绕过，也不向前端暴露 Admin 私钥。

- provision:altana-x402 在发送 grant 前保存加密恢复材料，Authority 初始 invalid；grant、checker、allowance 全部确认后才 active。
- 不允许覆盖旧 authorityId。grant 响应丢失时保留密钥/检查点，禁止自动重新 grant；先检查链上状态，再按单独授权执行清理。
- revoke:altana-x402 先禁用本地密钥使用，逐笔保存确认结果；重试跳过已确认步骤。未确认的撤销操作可能重试并消耗 gas，仍受现有广播确认开关保护。
- 只有明确的 revoked/unknown session key 拒绝才完成负向测试。网络超时、余额不足、过期、泛化 revert、pending 都是 inconclusive，不伪造成功。
- 全部撤销并明确拒绝后删除加密材料；重复执行已完成撤销不会再访问钱包/RPC。
- /authority 暴露 lifecycle 的 operation/phase/pendingStep/transactions。现有状态模型没有 revoking，期间表现为 invalid + revoke/in-progress。
- 本地停止签名不等于撤回此前已发送的签名；真正链上失效以确认的 revoke 为准。

## Sentinel 第二审计服务

npm run dev:sentinel 使用 :3006、sentinel-audit-v1、独立收款钱包、独立 facilitator 和默认 0.4 U 报价。它不是端口 :3005 的 Investigator，也不再借用一个静态 Legacy 条目冒充在线竞争服务。

配置项见 .env.example 的 SENTINEL_*。必须填写自己的持久钱包和 facilitator；x402 不允许随机 mock 钱包，且不能与 Auditor 共用身份钱包。模型可用 SENTINEL_LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL 和对应 API key 单独设置。所有 audit-vulnerabilities-v1 服务在模型缺失/失败时明确失败，不返回空漏洞的假成功。

Sentinel 独立 payee / facilitator 已生成并存入本机 macOS Keychain，私钥未写入仓库或证据。facilitator 已获 0.0002 tBNB；payee `0x1Ef8eEb640e60d5d3Bc3eFe1A4b2fFCd64132c2C` 已完成 0.4 U 实付验收，交易 `0xbca135b7bf3d8a65d5bd1670817ca6bfea8eb3766213ee08c4c47d539f485bf1`，签名 Receipt 和 4 个结构化 finding 已归档到 `evidence/stability/sentinel-paid-acceptance.json`。

空的通用 `X402_RECEIPT_STORE_PATH=` 现在会正确回退到 profile 专属默认文件，不再被解析成仓库目录。Service Host 的 LLM 调用增加真正的硬超时（`LLM_TIMEOUT_MS` / `*_LLM_TIMEOUT_MS`）；即使底层 SDK 忽略 AbortSignal，HTTP 任务也会在边界内结束并保留已结算原单供无付款恢复。

## ERC-8004 注册

Hunter 提供规范的 `GET /agent-registration.json`，注册成功后会从本地链上身份记录填入 `registrations`。`npm run preview:erc8004 --workspace @rebel/hunter` 先验证 chain 97、官方 IdentityRegistry 合约代码、公开 HTTPS registration JSON、calldata、gas 和所有者余额；没有 `ERC8004_REGISTER_CONFIRM=I_CONFIRM_ERC8004_REGISTRATION` 时只预览不广播。当前没有公开部署地址，因此 `HUNTER_AGENT_URI` 缺失，预检明确停止；不要把 localhost、临时隧道或已禁止的阿里云地址写上链。

链上 Identity Store 在 file 模式使用 0600 原子替换和跨进程锁，在 postgres 模式写入共享 `onchain_identities`。注册脚本的 file 锁覆盖预检、广播、Receipt 和本地落盘；若在广播后崩溃会故意留下锁，必须先查链后再处理，不能直接重试注册。

## 持久化和运行限制

- Session/evidence/settlement 的写入采用原子替换和本地跨进程锁。锁目录为相应文件加 .lock；生命周期和对账另有专用锁。
- 任务 admission/trace/terminal 状态也采用本地跨进程锁和原子替换；mission 历史投影的多实例写入不再丢记录。
- 崩溃可能遗留锁；必须先确认对应进程不在写入，再人工移除那个精确的空锁目录。工具不按超时自动抢锁，避免覆盖仍在运行的写入。
- 文件 Store 仍是默认运行后端，只适用于单机。`STORE_BACKEND=postgres` 时 Hunter、Registry、Service Host、恢复/对账入口会统一使用数据库，并在 schema 缺失或数据库断连时 fail-closed，不会回退文件。
- `docker-compose.postgres.yml`、`database/migrations/` 和运行适配器覆盖 run/idempotency/event、mission、Hunter memory、x402 purchase/execution/chain evidence、Authority 公共 journal、service lease/reputation、Agent feedback/identity、ERC-8004 状态和 transactional outbox。Session 私钥仍只允许加密本地 Store 或未来的 KMS/Secret Manager。
- PostgreSQL 的服务反馈按 `(serviceId, hunterId, missionId)` 幂等；同一逻辑反馈因 HTTP 响应丢失而重试时更新原记录，不会重复抬高/压低 Reputation。
- `npm run db:import:files` 默认 dry-run；确认短语启用单事务导入，非空目标拒绝，源文件哈希/行数/付款总额不一致会回滚，相同源摘要重复执行只校验不重写。切换期间禁止 dual-write。
- 已付款服务执行可在失败后重试。当前执行器是报告生成；将来若接入会产生外部副作用的工具，需要单独的执行幂等保护。
- 自动恢复历史审计要求原请求、v2 签名、独立 Verifier、同任务同 sourceHash；不再按几分钟内的相近付款拼接任务。旧冻结 mission 记录仍可查看。

## 验收与未完成项

npm run verify：Node 20.19+，typecheck、单元/HTTP 回归、证据校验、前端 build；不广播、不调用付费模型。回归使用临时数据和假 facilitator，不能当成新链上验收。

2026-09-04 后端增强验收：新增任务幂等提交、稳定 missionId、SSE 断线回放、显式取消、重启后 fail-closed、不可用能力过滤、LLM 硬超时与空配置归一化。

同日新建 `agora-v2-sentinel-20260904-01`（24h / 1.15 U，仅 Auditor、Verifier、Sentinel），完成 Auditor 0.5 U、Verifier 0.25 U、Sentinel 0.4 U。Auditor 模型连接曾超时，系统依据精确 mission/request/transaction 做一次无付款交付恢复，再支付 Verifier；没有重复扣款。随后 Checker、Permit2 allowance、Session 全部撤销，allowance 独立复核为 0，Checker 列表为空，负向 1 wei U 转账被明确拒绝，本地 Session 材料已删除。验收证据位于 `evidence/stability/auditor-verifier-paid-acceptance.json` 和 `evidence/stability/sentinel-paid-acceptance.json`。

恢复完成会同时将 mission 投影与 durable run 的同一 mission 终态校准为 completed；重跑恢复命令只同步缺失终态，不再调用 Verifier 或支付。running/cancelled、goal 不一致或不同结果都会拒绝覆盖。

仍需分别处理：需要公开 HTTPS URI 的 ERC-8004 实际注册、获明确批准的独立部署环境、该环境上的 PostgreSQL 多可用区/PITR/Secret Manager 验收，以及最终提交材料。前端样式由用户后续调整。浏览器 Authority 直签不再是当前交付项；若未来改为 Passkey smart wallet，应作为新的钱包和资金迁移流程单独设计与验收。

2026-09-04 浏览器只读验收通过：页面显示补充 Authority 为 revoked，`0.6 U` 限额与支出相符，两笔付款、Checker/Permit2/Session 三步撤销、负向测试拒绝和 Session 材料删除均可见。Chrome 同时启用多个 EVM 钱包扩展时会争抢 `window.ethereum`；这不是应用错误，但测试钱包连接时应只启用一个扩展。

PostgreSQL 本地门禁命令为 `npm run verify:postgres`；当前 14/14，覆盖 20 并发幂等、SKIP LOCKED、lease takeover/fencing、SSE cursor、付款原子事务/响应丢失重放、uncertain 对账、Outbox 重投、TTL、外部 mission ID、Agent/链上身份、反馈、Hunter memory、断连 fail-closed 和 Authority 无明文密钥测试。另已用两个真实 Hunter 进程验证共享 12 条历史、停一副本继续读取和进程重启恢复。`npm run db:down` 停止容器但保留本地卷。

严禁使用已撤除的阿里云 chaochenbass 生产主机。deploy/activate-fixed-host.sh 保持停用，本说明不授权任何部署。
