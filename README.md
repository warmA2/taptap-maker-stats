# TapTap 制造 · 输入与积分统计

> 记录你在 [TapTap 制造](https://maker.taptap.cn/) 的**每一次输入**，按**会话**和**项目**统计 token 与积分消耗，侧边栏常驻显示**当前登录用户的各项积分余额**。
> 一个纯本地的浏览器扩展 —— 数据只存在你自己的浏览器里，不上传任何服务器。

![version](https://img.shields.io/badge/version-0.9.47-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/Chrome%20%2F%20Edge-114%2B-lightgrey)
![manifest](https://img.shields.io/badge/Manifest-V3-orange)

---

## 它解决什么问题

TapTap 制造平台的积分消耗是**黑盒**：你不知道这一轮对话花了多少、哪个项目最烧钱、今天还剩多少通用积分、上下文什么时候开始撑不住。

这个扩展把黑盒撬开一条缝：

- 每轮输入的 **tokens / 积分消耗**，精确到单条消息
- **余额差分**校准 —— 消耗数字与页面上的余额变化严格一致，不是拍脑袋估算
- 按**项目 / 会话 / 天 / 小时**多维归集，谁在烧钱一目了然
- 侧边栏**常驻**，不用来回切页面看余额

---

## 功能

**侧边栏（点工具栏图标打开）**

| 模块 | 内容 |
|---|---|
| 注入状态 | 顶部显示当前页面是否已生效（未注入会提示刷新） |
| 我的积分 | 当前登录用户的完整积分构成：通用积分（长期 + 到期）、基础积分、付费积分、周期积分、会员卡权益、待发放批次；每 60 秒自动更新 |
| 今日概览 | 今日消耗、输入次数、按小时消耗曲线 |
| 消息归因 | 每条消息旁标注「消耗 X 积分 · 剩余 Y 通用积分」 |
| 完整版入口 | 一键打开完整 Dashboard |

**完整 Dashboard**

- 按日趋势（消耗 / 输入次数）
- 按会话排行 —— 以项目维度对比谁最烧钱
- 积分余额快照（余额随时间的变化曲线）
- 积分构成明细（最新一份快照的完整拆分）
- 项目积分消耗明细（最近 50 条）
- 输入明细（原文 + tokens + 积分）
- 调试面板（最近 300 条原始捕获事件，用于排障）

**其他**

- 1 Token → 积分 的折算倍率可在设置页校准
- 支持导出诊断 JSON（手动触发）
- 全程只读页面数据，**不修改页面任何行为**

---

## 安装

### 方式一：下载 Release（推荐）

1. 到 [Releases](../../releases) 下载最新的 `taptap-maker-stats.zip` 并解压
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 右上角开启 **开发者模式**
4. 点 **加载已解压的扩展程序**，选择解压出来的文件夹

### 方式二：源码加载

```bash
git clone https://github.com/warmA2/TapTapMakerHelper.git
```

然后在 `chrome://extensions` 里加载这个目录（`manifest.json` 就在根目录）。

**环境要求**：Chrome / Edge **114+**（Side Panel API），且需 **111+**（`world: "MAIN"` 注入）。

---

## 使用

1. 打开 <https://maker.taptap.cn/> 正常对话（发消息、等回复）。
   **装好扩展后必须刷新一次页面** —— 注入只在页面加载时发生（侧边栏顶部会显示「已注入页面」）。
2. **点工具栏扩展图标** → 统计面板常驻浏览器右侧边栏，切换标签页也一直存在，每 10 秒自动刷新。
3. 顶部「我的积分」实时显示各项余额；点「我的积分页 ↗」跳官方明细页。
4. 点「完整版 ↗」打开 Dashboard 看趋势、排行、明细。
5. 右键图标 →「选项」可配置积分折算倍率。

> 侧边栏显示「未注入」时：确认扩展已加载 → `chrome://extensions` 点「重新加载」→ **刷新 maker.taptap.cn 页面**。升级扩展后这两步都要做一遍。

---

## 工作原理

扩展以 **MAIN world** 在页面最早期注入（`document_start`），挂钩三个通道。只旁路读取，不改写请求与响应：

| 通道 | 捕获点 | 用途 |
|---|---|---|
| WebSocket 发送 | `_taptap/session/prompt` 请求体（`params.prompt`） | 记录每次输入原文 + 会话 ID |
| WebSocket 接收 | `session/update` 中的 `agent_message_chunk`、`prompt/stopped`、RPC 回包 | 累计输出文本、提取 usage / tokens / credits |
| fetch / XHR | `/api/v1/chats/{id}`、`/api/v1/chats/{id}/context-usage`、`/api/v1/credits`、`/api/v1/credits/batches`、`/api/v1/apps` | 会话标题、上下文用量、积分余额与批次、项目列表 |

**积分数据的优先级**

1. 响应里直接出现的 `credit*` 字段 —— 实测值，最可信
2. 抓不到时按 `(输入 Tokens + 输出 Tokens) × 倍率` 估算，倍率可在设置页校准
3. 余额快照做**差分**校验，两者不一致时以余额变化为准

**校准倍率**：打开官方「我的积分」页，记录一次对话前后的余额差，与 Dashboard 的估算值对比，把倍率改成 `实际扣减 ÷ 估算值` 并保存，Dashboard 会重新估算。

---

## 数据与隐私

- 所有数据保存在**本机**：IndexedDB 库 `tt-maker-stats`，另用 `chrome.storage.local` 存少量运行状态。
- **不上传、不埋点、不做任何网络外发**。没有任何第三方服务器参与。
- 权限用得很少，且都与功能一一对应：

| 权限 | 用途 |
|---|---|
| `storage` | 存储运行状态 |
| `sidePanel` | 常驻右侧边栏 |
| `scripting` | 向 maker.taptap.cn 注入捕获脚本 |
| `downloads` | 仅在你点「导出诊断」时下载 JSON |
| `host_permissions: https://maker.taptap.cn/*` | 仅在该域名下读取积分与消息 |

**数据表结构**（IndexedDB `tt-maker-stats`，v2）

| 表 | 主键 | 内容 |
|---|---|---|
| `chats` | `id` | 会话 ID → 标题、最后活跃时间 |
| `prompts` | `turnId` | 一轮对话：输入/输出文本、tokens、积分、起止时间 |
| `ctx` | `id` | 会话上下文用量快照 |
| `balances` | `ts` | 积分余额快照 |
| `txns` | `id` | 积分流水（差分校验） |
| `raw` | `seq` | 最近 300 条原始事件（调试用） |

**清除数据**：卸载扩展并清除站点数据即可全部删除。

---

## 常见问题

**完全没数据？**
扩展加载后要**刷新 maker.taptap.cn 页面**，注入才会发生。改代码后还要在 `chrome://extensions` 点一次「重新加载」。

**Side Panel 打不开 / 图标点了没反应？**
确认浏览器版本 114+。Edge 需在 `edge://settings/sidebar` 允许扩展使用侧边栏。

**积分数字和官方页对不上？**
优先看余额差分（官方口径）。若长期偏差，按上面「校准倍率」调一次。

**平台改版抓不到了？**
打开 Dashboard 底部调试面板，导出诊断 JSON 提 issue —— 里面是原始事件，足够定位解析规则要改哪里。

---

## 目录结构

```
.
├── manifest.json      # MV3 清单（版本号在这里改）
├── main-hook.js       # MAIN world 注入：钩 WS / fetch / XHR
├── content.js         # 隔离世界桥接：把捕获事件转给 background
├── background.js      # Service Worker：解析、入库（IndexedDB）、聚合查询
├── sidepanel.html     # 侧边栏 UI
├── sidepanel.js
├── dashboard.html     # 完整数据看板
├── dashboard.js
├── options.html       # 设置页（积分倍率）
├── options.js
└── icons/             # 16 / 32 / 48 / 128
```

**开发**：纯静态、无构建步骤。改完文件 → `chrome://extensions` 点「重新加载」→ 刷新 maker.taptap.cn 页面。版本号只改 `manifest.json` 里的 `version`。

---

## 免责声明

本项目为**非官方**第三方工具，与 TapTap / 心动网络无任何关联，也未获其授权或背书。
它只读取你**自己账号**在你**自己浏览器**里可见的数据，用于个人统计。请自行遵守平台用户协议；因使用本扩展产生的任何后果由使用者自行承担。

---

## License

[MIT](LICENSE)
