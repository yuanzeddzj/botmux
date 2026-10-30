# 产品上下文

## Name（产品名称）
BotMux

## Description（产品描述）
BotMux 将飞书或 Lark 会话桥接到用户已经在使用的 AI 编程 CLI。用户可以从手机或桌面发起任务、查看实时输出、补充上下文、确认关键动作，并让多个机器人在相互隔离的会话中协作。

## Audience（目标受众）
在开发机上使用 AI 编程 CLI 的研发人员、技术负责人和运维人员。他们经常在移动端或群聊中处理并行任务，需要快速理解当前状态，并在变更、发布、扩容、回滚等节点做出低歧义的决定。

## Register（语域）
- [ ] Brand（品牌层面）— 对外传播、营销材料
- [x] Product（产品层面）— 界面文案、功能说明

## Brand Personality（品牌个性）
可靠、直接、克制、清晰、技术友好

关键词：任务导向 / 状态明确 / 可核验

## Existing Assets（现有资产）
- Logo：有，仓库根目录 `cover.svg`
- 品牌色：沿用飞书卡片官方语义色；蓝色表示待处理，绿色表示成功，橙色表示风险或超时，红色表示危险操作，灰色表示失效
- 字体：使用飞书客户端的系统字体
- 设计稿：已有卡片构建代码、离线 HTML 示意和文档图片，位于 `src/im/lark/`、`docs/assets/` 与 `docs/`
- 其他：卡片交互由飞书原生组件承载，不自绘字体、按钮或动效

## Technical Context（技术上下文）
- 框架：TypeScript、Bun、飞书/Lark Card JSON 1.0 与 2.0
- 样式方案：飞书卡片原生 header template、Markdown、fields、button、column_set 和 form 组件
- 部署环境：macOS 与 Linux 开发机上的 BotMux daemon，消息显示在飞书/Lark 客户端
