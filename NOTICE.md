# NOTICE — Sakura-MCP-Server 许可证采用声明

本文件按《[Sakura-License 采用与授权指引](https://wiki.mcylyr.cn/#/../docs/sakura-license-adoption)》记录本项目的许可证采用信息，与 `LICENSE` 配套使用，本身不是许可正文。

## 项目身份

- 项目名称：Sakura-MCP-Server
- 官方仓库：https://github.com/Guyao146/Sakura-MCP-Server
- 原始来源：本仓库自创建，无外部上游源码

## 权利主体

版权归属以 Git 提交记录为准；人工提交均由 Guyao146（guxuan.mojang@outlook.com）作出，另有仓库自动化工作流以 GitHub Action 身份作出的提交（发布与锁文件更新等）。商业许可与法律通知入口：[GitHub Issues](https://github.com/Guyao146/Sakura-MCP-Server/issues)。

## 适用范围

- 适用：`src/`、`migrations/`、`scripts/`、`tools/cline-sync/`（含其 `package.json` 与发布产物）、`tests/`、`docs/`、`Dockerfile`、`docker-compose*.yml`、`nginx-mcp.conf.example`、`.github/` 等本仓库原创文件，以及随 `package.json` `files` 字段发布的 `dist/`、`migrations/`、`README.md`、`LICENSE`、`NOTICE.md`。
- 不适用：`node_modules/` 与构建引入的第三方依赖，各自保持原许可；与本仓库原创文件一同存放或分发的第三方内容不因分发而改用本许可。

## 固定许可版本

- 许可正文：`LICENSE`，为 **Sakura-License v1.2** 正式固定版本（文本标识 `Sakura-License-1.2`，发布日期 2026-10-04；条文与审阅稿修订 3 逐字一致，仅标题、文本标识、前言与状态表述不同）。
- 该许可限制特定商业利用，属于源码可用（source-available）许可证，不是 OSI 批准的开源许可证，也没有 SPDX 短标识；在物料清单中引用写作 `LicenseRef-Sakura-License-1.2`。
- 固定正文规定：本许可不因存放而自动适用于任何项目，仅当有权许可的主体就其作品作出明确采用声明时，才对采用声明列出的作品生效。权利主体在此声明：自本仓库首次同时包含采用声明与 `LICENSE` 的提交起，对本作品适用 Sakura-License v1.2。采用声明生效期间曾使用审阅稿正文，现替换为正式固定正文；已授予的权利不因替换而改变。
- npm 元数据：`package.json` 与 `tools/cline-sync/package.json` 的 `license` 字段写作 `SEE LICENSE IN LICENSE`。

## 生效边界

- 首次适用：包含本声明与当前 `LICENSE` 的 `main` 分支提交，及此后发布的全部版本。
- 此前的发布版本（含 `v0.4.0` 及更早 tag）按其发布时的 LGPL-2.1-only 授权。

## 历史权利

- 本仓库历史版本按 LGPL-2.1-only 授予接收者的权利不追溯撤销：既有的复制、修改、再分发与 LGPL 链接权继续有效。
- 历史提交者在采纳 Sakura-License 之前的贡献，按其作出时适用的 LGPL-2.1-only 授权。

## 第三方内容

- 运行与开发依赖（`pg`、`hono`、`jose`、`zod`、`pino`、`dotenv`、`@modelcontextprotocol/*`、`@hono/node-server`、`typescript`、`vitest`、`tsx` 等）保持各自许可（MIT / Apache-2.0 / ISC / BSD 等），以各依赖包自带的许可证声明为准。
- 本项目不对外部依赖的许可合规性作担保；分发或再分发时应自行核对依赖清单。
