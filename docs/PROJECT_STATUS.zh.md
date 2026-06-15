# Planfect 项目情况（中文进度跟踪）

> 这是项目的中文进度文件。每完成一轮我都会更新这里：**目标、技术栈与决策、当前状态、各轮进度、计划、以及当前缺什么/待办**。
> 英文文档在根目录 `README.md` 和 `docs/` 里。

最后更新：第 5 轮。

---

## 一、目标

做一个 **AI 日程规划 App**（项目名 **planfect**）。用户用**语音或文字**随口记录哪天/哪几天要做什么，AI 自动：

- 判断任务的大致**时长**；
- 学习并**避开常规作息**（上班、通勤、睡觉、吃饭）；
- 把任务**排进空闲时间**；
- 对在**外地**的事，算好**通勤时长和方式**。

界面：**对话**（和 AI 说安排；它不确定时给你多选题 + "其他"选项；完成后给回执）+ **日/周日程表** + 右上角**个人界面**。
**最终目标：上 App Store**（iOS 优先，安卓以后再说）。

---

## 二、技术栈与关键决策（详见 `docs/DECISIONS.md`）

| 层 | 选择 | 理由（简） |
|---|---|---|
| iOS App | **原生 SwiftUI** | iOS 优先、体验最好、Apple Maps/语音/日历都是一等公民 |
| 后端 | **Supabase**（Postgres + Auth + 存储 + Edge Functions）| 关系型数据库贴合排程；密钥放服务端；不锁 Apple，安卓可复用 |
| AI | **OpenAI / Anthropic / Qwen 可切换**，统一 `PlannerLLM` 接口 | 你两边都有 credit，且想试国内模型 |
| 地图 | 服务端 **MapsProvider** 抽象（Apple 默认；Google；高德留给中国）| 通勤算在服务端，一次往返完成规划 |
| 市场 | **国际优先**，中国以后 | 上架与 AI 接入最顺 |
| 分析 | **用量记账 + 独立管理后台 dashboard** | 看用户数、调用数、用量、成本、模型对比 |

> 重要安全原则：**App 里不放任何第三方密钥**，所有 AI/地图调用走 Supabase Edge Functions（服务端）。

---

## 三、当前状态（截至第 4 轮）

- ✅ 设计文档齐全；数据库 schema + 行级安全；分析表 + dashboard 视图。
- ✅ 后端核心逻辑（TypeScript）写好并**单测通过（server 23/23 + dashboard 5/5，Node 跑）**：排程引擎（含**时区感知的"作息→时间窗"**）、planner agent 循环（含多选澄清问题的"中断—回答—继续"机制）、多 provider LLM 层、用量记账。
- ✅ **端到端 demo 可在本机直接跑**（无需任何 key）：`node --experimental-strip-types server/demo/planDemo.ts`
- ✅ `/plan` Edge Function 脚手架 + `seed.sql`。
- ✅ 开发者 **dashboard web 脚手架**：纯计算函数有单测；UI 读 `metrics_*` 视图。
- ✅ **CI**（GitHub Actions）每次 push 自动跑全部测试。
- ⬜ 还没开始：**iOS App 本体**、连真实 Supabase 部署、接真实模型 key。

---

## 四、各轮进度

- **第 1 轮** — 定方向（技术栈 / 市场 / 后端）+ 全套设计文档 + 数据库 schema。（PR #1 起点）
- **第 2 轮** — 后端核心代码（排程引擎、planner 循环、多 provider、用量记账）+ 分析表/视图；单测 18/18。
- **第 3 轮** — `/plan` Edge Function 脚手架 + 可运行端到端 demo + `seed.sql`。
- **第 4 轮** — 开发者 dashboard web 脚手架 + 本中文进度文件。
- **第 5 轮（本轮）** — 加 CI（GitHub Actions 跑测试）+ 补完"作息→时间窗（时区感知）"纯函数并测试；demo 改用真实作息派生时间窗。

---

## 五、计划 / 路线图（详见 `docs/ROADMAP.md`）

- **Phase 1** — 建 Supabase 项目、跑 `schema.sql` + `analytics.sql`、补 `/plan` 写库 handler、部署函数。
- **Phase 2** — planner 接真实模型，澄清问题流程上线，开 prompt 缓存。
- **Phase 3–6** — iOS App：三界面 → 对话 + 语音 → 地图通勤 → 通知打磨。
- **Phase 7** — 上 App Store（Apple 开发者账号、隐私合规、TestFlight）。
- **Phase 8** — dashboard 上线（接真实数据 + 图表）。
- **以后** — 高德/微信登录（中国）、安卓、日历双向同步、循环任务。

---

## 六、当前缺什么 / 待办

**需要你（到家 / 有账号时）：**
- 建 **Supabase 项目**，跑 `schema.sql` + `analytics.sql`；建测试用户后跑 `seed.sql`。
- 配 **OpenAI / Anthropic / Qwen 的 key**、**Apple Maps token**（放 Supabase secrets / `.env`）。
- **Mac + Xcode**：开始 iOS App（原生 SwiftUI）。
- **Apple Developer 账号**：上架准备。

**代码侧待补：**
- `/plan` 里 `schedule_tasks` 的**真实写库**（载入 busy + 插入 `time_blocks`）——"作息→时间窗"已用 `server/scheduling/routines.ts` 实现并测试，剩 DB 读写部分。
- 三个 provider 适配器的**集成测试**（接真实 key 后）。
- 把 **Qwen 价格**填进 `server/usage.ts` 的 `PRICING`（现在是占位）。
- dashboard **接真实数据 + 图表**（recharts），以及把"服务端 service role"换成"管理员登录"方式。

---

## 七、怎么自己看 / 怎么继续

- **有 Mac 了？照着 [`SETUP.zh.md`](SETUP.zh.md) 一步步继续（把 Claude Code 跑到 Mac 上 → 建 Supabase → 做 App）。**
- 跑测试：`npm test`
- 看流程 demo：`node --experimental-strip-types server/demo/planDemo.ts`
- dashboard 纯函数测试：`cd dashboard && npm test`（UI 需 `npm install && npm run dev`）
- 想推进：跟我说 **"继续"**，或指定要做哪块（如"接真实模型"、"开始 iOS App"）。
