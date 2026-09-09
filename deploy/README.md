# Agora Mesh 部署

2026-09-09 已获授权的新独立服务器为 `43.165.167.118`（腾讯云东京，2 核 4GB）。
部署状态、运行目录和新脚本见 [DEDICATED_DEMO.md](./DEDICATED_DEMO.md)。
新流程使用 `bootstrap-demo.sh`、`build-demo.sh <commit>`、
`prepare-demo-env.mjs`、`activate-dedicated-demo.sh <commit>` 和
`dedicated-demo.Caddyfile`。公网可用状态以部署状态文档中的验收结果为准。

## 已停用的旧入口

2026-09-03，用户明确要求阿里云服务器 `112.74.165.78`（`chaochenbass-prod`）只放 chaochenbass 相关内容。Agora Mesh 在该服务器的两次依赖安装触发了网站故障，该服务器不是本项目的部署环境。

`activate-fixed-host.sh` 已在任何 SSH、上传或安装操作前直接退出，并移除了 `chaochenbass-prod` 默认主机。现有 `agora-mesh.Caddyfile` 及脚本后部的 nip.io 地址是停用的历史配置，不得直接用于发布。

后续需要在独立服务器或部署平台上重新配置本项目的主机、域名和资源预算。本目录旧配置不能作为使用 chaochenbass 服务器的授权。
