# DeepSeek 联网证据包说明

当前正文校准不再使用本地 sidecar，也不需要 npx、Node 服务或 API key。

现在的流程是：

```text
DeepSeek 模式 + 用户勾选“正文外貌/时间点校准”
  ↓
正文生成前按场景判断是否需要查外貌 / 时间点
  ↓
前端直接请求 DuckDuckGo HTML 搜索
  ↓
解析标题、链接、摘要，整理成 evidencePacks
  ↓
作为 webEvidenceContext 注入本轮正文 prompt
```

约束：

- 默认关闭。
- 不写世界书。
- 不改 `StatusData`、记忆库或角色档案。
- 不进入普通模式。
- 只用于本轮正文前的外貌、角色设计细节、canon 时间线与用户输入事实校准。
- “百科优先”只是 DDG 查询时按路人女主 Wiki、百度百科、萌娘百科增加来源倾向，不是 API 配置。
