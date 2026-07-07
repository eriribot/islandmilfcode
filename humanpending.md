# Human Pending

## HP-001：是否批准运行 SRW Harness Codex Task Loop

状态：pending

## 决策

是否允许执行第一轮 runner：

```powershell
python .codex-loop/scripts/codex-loop.py next
```

## 为什么是真正人类门

`codex-task-loop` 明确要求：生成计划后，用户审阅并批准前，不启动 runner。当前 runner 会调用 `codex exec` 并实际修改项目文件，因此需要人类批准。

## 当前可继续推进的非依赖工作

- 完善 `.codex-loop` 的审阅包、参考索引、任务说明和检查材料。
- 执行只读状态检查。
- 不运行 `next`。
- 不运行 `start`。

## 可选决策

- 批准只运行 `TASK-001`。
- 批准连续运行 `start --max-rounds 20`。
- 要求先调整任务队列或文档边界。
- 暂不运行，仅保留计划。

## 复查条件

当用户明确说“批准运行 TASK-001”、“批准 next”、“批准 start”或等价授权时，更新本文件并执行对应命令。
