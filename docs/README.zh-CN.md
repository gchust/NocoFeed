# NocoFeed

[English](../README.MD) | 简体中文

NocoFeed 是一个基于 [NocoBase 3](https://www.nocobase.com) 的开源个人兴趣信息流。它替你关注 Hacker News、Reddit、RSS、YouTube 和
Bilibili，告诉你哪些讨论值得参与、哪些内容值得学习，并说明每个判断依据的是哪些材料。

## 能做什么

- **一条为你排序的信息流。** 订阅带来新内容，按你的主题和真实经验逐条匹配，标为「参与」「学习」或「略过」。
- **诚实的分析。** 默认用关键词规则，配置 AI 模型后由模型分析。每条分析都会说明读了什么、没读到什么。
- **今日简报。** 过去 24 小时最值得参与的 3 条和最值得学习的 1 条，在你设定的时间发到站内信。
- **从反馈中学习。** 「有用」「不相关」会调整命中词的权重，信息流立即重新排序。
- **快速处理。** 紧凑列表加键盘快捷键：`j`/`k` 移动、`s` 收藏、`l` 稍后看、`x` 移出、`o` 打开原文。
- **替你跟进回复。** 填入你在 Hacker News 或 Reddit 的发言链接，有人回复时提醒你。
- **盯着订阅源。** 连续失败或长期没有新内容的订阅会被标出来。

## 快速开始

需要 Node.js 24 或更高版本，以及 pnpm 11（`corepack enable`）。

```bash
git clone https://github.com/gchust/NocoFeed.git
cd NocoFeed
pnpm install
pnpm nocobase config init --dialect sqlite
pnpm dev
```

打开 `pnpm dev` 输出的 `Local:` 地址（通常是 `http://127.0.0.1:13000/main/`），用 `nocobase` / `admin123`
登录（对外开放前请修改密码）。然后：

1. 在 **Interests & skills** 里描述你的兴趣和经验。
2. 在 **Topics** 里添加关注的主题。
3. 在 **Subscriptions** 里添加订阅源，点 **Run now**。

可选：在 **System settings → AI models** 添加 AI 模型，由模型撰写分析；需要登录态的平台（小红书、X、视频搜索与字幕）见
[`collector.md`](collector.md)。

配置、升级、构建与 Docker 部署见[开发与部署](development.md)。
