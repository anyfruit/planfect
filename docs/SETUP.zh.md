# 上手 / 继续开发指南（中文）

> 你现在的位置：**不依赖 Mac 的基础已全部完成并有测试 + CI**（设计文档、数据库 schema、
> 后端逻辑、`/plan` 脚手架、可运行 demo、dashboard 脚手架）。下一大步是 **iOS App 本体**，
> 必须在你的 Mac 上做。这份指南就是"怎么从这里继续"。

进度全貌见 [`PROJECT_STATUS.zh.md`](PROJECT_STATUS.zh.md)，路线图见 [`ROADMAP.md`](ROADMAP.md)。

---

## 第 1 步：在 Mac 上准备三样东西

1. **Xcode**（做 iOS App 必需）——App Store 搜 Xcode 安装。**很大，先点下载**，边下边做下面的。
2. **Claude Code + 代码**——把我跑到本机，并拿到全部成果：
   ```bash
   # 安装 Claude Code（桌面版或 CLI，按官网指引），登录后：
   git clone https://github.com/WeijieCao77/planfect.git
   cd planfect
   git checkout claude/practical-volta-cjfw7m   # ← 全部成果都在这条工作分支上
   # 验证一切正常（需要 Node ≥ 22）：
   npm test                                              # 应 23/23
   node --experimental-strip-types server/demo/planDemo.ts   # 看完整规划流程
   ```
   > 注意：`main` 分支目前只有第 1 轮的文档；**完整代码在 `claude/practical-volta-cjfw7m`**。
   > 满意后可以把 PR #1 合并到 `main`（见最后一节）。
3. **账号 / Key**：
   - 注册 **Supabase**（免费），建一个 project（记下 Project URL、anon key、service_role key）。
   - 准备 **OpenAI API key**（你有 credit）。可选 Anthropic / Qwen key。
   - （地图、真机、上架时才要）**Apple Developer 账号**（$99/年）——先用模拟器不需要。

---

## 第 2 步：把我（Claude Code）跑在 Mac 上

1. 在 Mac 上用 Claude Code 打开 `planfect` 这个文件夹，开一个新会话。
2. 直接跟我说一句，比如：**"继续 Phase 1"**，或 **"开始建 Supabase 并部署 /plan"**，或 **"先搭 SwiftUI App 骨架"**。
3. 我会读 `ROADMAP.md` / `PROJECT_STATUS.zh.md` 接着干——这次我能**直接开 Xcode、跑模拟器、操作浏览器**配 Supabase。

---

## 第 3 步：到 Mac 上后我们的推进顺序

| Phase | 我帮你做的 | 产出 |
|---|---|---|
| **1 后端落地** | 建 Supabase、跑 `schema.sql` + `analytics.sql`、部署 `/plan` Edge Function、补完写库 handler | 一个能用真实账号鉴权、能读写日程的后端 |
| **2 planner 接真实模型** | 把 agent 循环接到 OpenAI，澄清问题流程跑通 | 命令行就能"发消息 → 出多选问题 / 排程回执" |
| **3 App 骨架** | Xcode 建 SwiftUI 工程，三界面（对话 / 日程表 / 个人）+ 登录，连 Supabase | 能登录、看日程、改作息的 App（模拟器里） |
| **4 对话 + 语音 + 卡片** | 聊天界面调 `/plan`、渲染多选卡片（带"其他"）、麦克风听写 | 核心体验跑通 |
| **5 地图通勤** | 接 Apple Maps，自动插通勤块 | 在外地的事自动算通勤 |
| **6 打磨 + 通知** | 提醒、冲突处理、空状态、引导 | 接近可用 |
| **7 上架** | Apple Developer、隐私合规、截图、TestFlight、提审 | 上 App Store |

**建议顺序**：先 **Phase 1→2**（后端先活起来，命令行可测），再 **Phase 3** 做 App；
如果你想尽快看到界面，也可以先搭 App 骨架，后端并行补。到时候告诉我你的偏好即可。

---

## 费用 / 账号清单

| 项目 | 何时需要 | 费用 |
|---|---|---|
| Supabase | Phase 1 起 | 免费档起步够用 |
| OpenAI（或 Anthropic/Qwen）key | Phase 2 起 | 按用量，你有 credit |
| Apple Developer | 真机调试 / 上架（Phase 5/7） | $99/年 |
| 地图（Apple Maps token 等） | Phase 5 | Apple Developer 内含 |

---

## 常用命令

```bash
npm test                                                  # 后端 23 个测试
node --experimental-strip-types server/demo/planDemo.ts   # 端到端规划 demo
cd dashboard && npm test                                  # dashboard 纯函数测试
cd dashboard && npm install && npm run dev                # 开发者后台（localhost:3000）
```

---

## 关于分支与 PR

- 目前所有开发都在 **`claude/practical-volta-cjfw7m`** 分支，对应 **PR #1（草稿）**。
- 到 Mac 后可以继续在这条分支上做；CI 会自动跑测试。
- 当你觉得这套基础 OK 了，可以在 GitHub 上把 PR #1 **标记为 Ready 并合并到 `main`**，
  之后再开新分支做后续 Phase（或继续用这条，随你）。
