# pi-status-tab

> 在终端标签页（iTerm2、Zed、kitty、WezTerm 等）和 pi 内置状态栏中显示 pi 的运行状态，支持识别 [pi-subagents](https://github.com/i-am-bee/pi-subagents) 等子代理工具。

当 pi 在你当前没有查看的标签页里运行时，你通常无法分辨它仍在执行、正在等待子代理，还是已经完成。`pi-status-tab` 会把 pi 的当前状态写入到标签页标题里，下一次扫一眼就能立刻知道当前的状态。

```
π my-project                       ← 空闲
⏳ π my-project · turn 3           ← 主 agent 正在工作
🔄 π my-project · subagents 1/3    ← 还有 2 个 subagent 在跑
✓ π my-project                     ← 刚完成
✗ π my-project                     ← 出错了
```

同样的信息也会在 TUI 底部的状态栏里以一行小字呈现。

## 为什么需要这个扩展

仅靠一个标题栏的转圈动画是不够的。当启用了 [pi-subagents](https://github.com/i-am-bee/pi-subagents) 的 async 模式时，主 agent 会很快把控制权交回给用户，而真正的子任务在后台继续运行。仅基于 `agent_start` / `agent_end` 的转圈动画会在这个窗口里错误地显示"已完成"。本扩展：

- 通过 `agent_start` / `agent_end` / `agent_settled` 跟踪主 agent 状态。
- 通过 `tool_execution_start` / `_end` 跟踪同步 subagent 调用（工具名为 `subagent`，覆盖内置 subagent 示例和 pi-subagents）。
- 通过扩展间事件总线（`pi.events.on("subagent:async-started" | "subagent:async-complete")`）跟踪 async subagent。即使在 `agent_settled` 之后，标签页会一直保持 "subagents" 状态直到最后一个 async subagent 完成。
- 在 TTY 模式下使用盲文转圈动画指示运行中状态。

## 安装

本扩展是一个标准的 pi 包。支持本地或全局安装。

### 本地安装（本仓库）

```bash
# 在本目录下执行：
pi install .
```

开发阶段也可以直接用 `-e` 指向源码文件：

```bash
pi -e ./src/index.ts
```

### 全局安装

```bash
pi install /Users/bytedance/Documents/github/pi-status-tab
```

### 从 npm 安装（发布后）

```bash
pi install npm:pi-status-tab
```

安装完成后重启 pi 或执行 `/reload` 即可生效。

## 使用

扩展默认开启。在 TUI 标签页里你会立刻看到标题随 agent 状态变化：开始工作 → 运行中 → 等待子代理 → 完成。

### `/status-tab` 命令

```
/status-tab                显示当前状态和配置
/status-tab on             启用
/status-tab off            禁用（标签页只显示项目名）
/status-tab title on|off   切换标签页标题更新
/status-tab osc on|off     切换直接写 OSC 到 stderr
/status-tab status on|off  切换内置状态栏
/status-tab spinner on|off 切换转圈动画
/status-tab async on|off   切换 pi-subagents async 跟踪
/status-tab format <text>  设置自定义标题格式
/status-tab reset          恢复默认
```

#### 标题格式占位符

| 占位符        | 说明                                          |
| ------------- | --------------------------------------------- |
| `{icon}`      | 状态图标：空（idle）、⏳、🔄、✓、✗         |
| `{symbol}`    | pi 符号（默认 `π`）                          |
| `{project}`   | 项目名（cwd 的 basename）                     |
| `{session}`   | 当设置了 session 名称时显示为 ` · <name>`     |
| `{turn}`      | agent 迭代时显示 ` · turn N`                  |
| `{progress}`  | subagent 进度，例如 ` · subagents 1/3 (+2 async)` |

示例：Claude Code 风格的标签页：

```
/status-tab format "{icon} {project} · {progress}"
```

## 配置

配置文件位置：

```
~/.pi/agent/extensions/pi-status-tab.json
```

默认值：

```json
{
  "enabled": true,
  "updateTitle": true,
  "useOsc": false,
  "updateStatusBar": true,
  "trackSubagents": true,
  "trackAsyncSubagents": true,
  "animateSpinner": true,
  "spinnerIntervalMs": 120,
  "completedDurationMs": 3000,
  "errorDurationMs": 5000,
  "titleFormat": "{icon} {symbol} {project}{session}{progress}",
  "statusFormat": "{icon} {label}{detail}",
  "showSessionName": true
}
```

可以直接编辑文件，也可以用 `/status-tab` 命令交互式修改最常用的开关。

### 何时启用 `useOsc`

`updateTitle` 调用的是 `ctx.ui.setTitle()`，是推荐的路径。TUI 模式下它会通过 pi 的 terminal interface 正确把标题写到宿主页面。

`useOsc` 是一个备选方案，会直接往 `stderr` 写 OSC 2 序列。它适用于非 TUI 调用（比如 RPC 包装器），那种场景下 `setTitle()` 是空操作。在普通的交互式 TUI 会话中保持关闭即可，pi 的 TUI 已经走正规通道更新标题。

## 兼容性

- 支持 OSC 2（Set Window Title）的终端：iTerm2、Zed、kitty、WezTerm、Alacritty、GNOME Terminal、Windows Terminal、Ghostty、Hyper、tmux、screen、Warp、Apple Terminal、VS Code 内置终端等。
- pi-subagents async 跟踪：任何通过 `pi.events` 总线发出 `subagent:async-started` / `subagent:async-complete` 公共事件的扩展。
- 同步 subagent 跟踪：任何以 `subagent`（区分大小写）为名称注册的工具。

## 项目结构

```
pi-status-tab/
├── package.json
├── tsconfig.json
├── README.md
├── README.zh.md
├── CHANGELOG.md
├── src/
│   ├── index.ts      # 扩展入口：把事件接到状态机
│   ├── state.ts      # 状态机
│   ├── title.ts      # 标题和状态栏格式化
│   ├── osc.ts        # OSC 转义序列写入
│   └── config.ts     # 配置持久化
└── test/
    ├── smoke.test.ts        # 单元测试
    └── integration.test.ts  # 实际 spawn pi 验证扩展加载
```

## 开发

```bash
npm install        # 一次性
npm run check      # tsc --noEmit
npm test           # 单元测试 + 集成测试
```

详细的开发者指南（状态机规范、事件接线、如何新增 title token 或 subagent 源、测试约定、相关的 pi 内部知识）请阅读 [AGENTS.md](./AGENTS.md)。

## 许可证

MIT
