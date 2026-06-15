# Planfect 项目情况（中文进度跟踪）

> 这是项目的中文进度文件。每完成一轮我都会更新这里：**目标、技术栈与决策、当前状态、各轮进度、计划、以及当前缺什么/待办**。
> 英文文档在根目录 `README.md` 和 `docs/` 里。

最后更新：第 6 轮。

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

## 三、当前状态（截至第 6 轮）

- ✅ 设计文档齐全；数据库 schema + 行级安全；分析表 + dashboard 视图。
- ✅ 后端核心逻辑（TypeScript）写好并**单测通过（server 23/23 + dashboard 5/5，Node 跑）**：排程引擎（含**时区感知的"作息→时间窗"**）、planner agent 循环（含多选澄清问题的"中断—回答—继续"机制）、多 provider LLM 层、用量记账。
- ✅ **端到端 demo 可在本机直接跑**（无需任何 key）：`node --experimental-strip-types server/demo/planDemo.ts`
- ✅ `/plan` Edge Function 脚手架 + `seed.sql`。
- ✅ 开发者 **dashboard web 脚手架**：纯计算函数有单测；UI 读 `metrics_*` 视图。
- ✅ **CI**（GitHub Actions）每次 push 自动跑全部测试。
- ✅ **Phase 1 后端已上线并跑通完整链路（真实 Supabase，ref `piyfhwmrumbexofbjqyu`）**：schema + analytics 已 `db push`；`/plan` Edge Function 已部署（JWT 鉴权）；`schedule_tasks` 真实写库已补完；**完整 `/plan` LLM 链路已实测**（真实 OpenAI `gpt-4.1`：agent 多步 estimate_commute → get_schedule → schedule_tasks → 回执；以及多选澄清问题分支），`tasks`/`time_blocks`/`usage_events`/`app_events` 均正确落库。
- ✅ **iOS App（SwiftUI）已跑起来（模拟器）**：登录、注册引导、Chat（接 `/plan`、多选澄清卡带"Other"、回执、语音按钮）、日程（日/周/月）、Profile；**端到端真机实测通过**。

---

## 四、各轮进度

- **第 1 轮** — 定方向（技术栈 / 市场 / 后端）+ 全套设计文档 + 数据库 schema。（PR #1 起点）
- **第 2 轮** — 后端核心代码（排程引擎、planner 循环、多 provider、用量记账）+ 分析表/视图；单测 18/18。
- **第 3 轮** — `/plan` Edge Function 脚手架 + 可运行端到端 demo + `seed.sql`。
- **第 4 轮** — 开发者 dashboard web 脚手架 + 本中文进度文件。
- **第 5 轮** — 加 CI（GitHub Actions 跑测试）+ 补完"作息→时间窗（时区感知）"纯函数并测试；demo 改用真实作息派生时间窗。
- **第 7 轮** — **iOS App 本体（SwiftUI）从零搭起并真机跑通**：XcodeGen 工程 + Supabase Swift SDK、邮箱密码登录、首次注册引导（写作息 + 设时区）、Chat（接 `/plan`、多选澄清卡带"Other"、回执按本地时间渲染、语音听写）、日程页（日/周/月读 `time_blocks`）、Profile。数据读写走 URLSession+JWT（SDK `client.from` 登录后带 token 不稳）。模拟器端到端验证：登录 → 引导 → 一句话排程（真实 GPT-4.1）→ 回执 → 日程表出现。剩：Sign in with Apple（Phase 7）、Profile 作息编辑器、回执点击跳转、精确钟点偏好。
- **第 6 轮** — **后端在真实 Supabase 上跑起来并端到端实测**：装 Supabase CLI（绕开 Xcode 直装二进制）、建迁移并 `db push`、部署 `/plan`、扩展 `schedule_tasks` 入参（加 `date` / 通勤 / 缓冲 / `earliest_start` 等）、补完真实写库 handler（`planningWindowsForDate` + 当天 busy + `scheduleTask` → 写 `tasks`/`time_blocks`）、`index.ts` 拆分用户态/service-role 客户端、建测试用户 + 种子数据。然后设 OpenAI/Anthropic secrets、给 system prompt 注入"今天日期"（解析"这周五 / 明晚"）、**跑通完整 `/plan` LLM 链路**（排程分支 + 澄清问题分支都实测）、修计价（vendor 返回的带日期 model id 按基础价兜底，dashboard 成本不再恒为 0）。**24/24 测试绿**。

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
- ✅ ~~建 **Supabase 项目**，跑 `schema.sql` + `analytics.sql`~~ —— 已完成（ref `piyfhwmrumbexofbjqyu`；迁移已 `db push`；测试用户 `test@planfect.dev` + 种子数据已建）。
- ✅ ~~**OpenAI key**（设为 Supabase secret，跑完整 `/plan` 实测）~~ —— 已设（默认 OpenAI `gpt-4.1`；Anthropic key 也已设，改 `ACTIVE_LLM_PROVIDER`/`PLANNER_MODEL` 即可切）；剩**可选** Qwen key、**Apple Maps token**（Phase 5）。
- **接受 Xcode 许可证**：`sudo xcodebuild -license accept`（解锁本机 git 提交，也修好 Homebrew）。
- **Mac + Xcode**：开始 iOS App（原生 SwiftUI）。
- **Apple Developer 账号**：上架准备。

**代码侧待补：**
- ✅ ~~`/plan` 里 `schedule_tasks` 的**真实写库** + 完整 `/plan` LLM 链路实测~~ —— 均已完成并实测（见第 6 轮）：排程分支 + 多选澄清分支都跑通，`usage_events` 落库且成本计价正确。剩 **Phase 2 打磨**：回执文案的本地时间渲染（模型把 UTC 转本地偶尔说错）、跨"问→答"持久化会话。
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
