# 测试门禁与发布

## 提交前

- `npm test` 全绿才准提交；不花真钱、不碰真实数据。
- 触及上游行为（请求格式、错误映射、模型目录解析、tools 拼装）时额外跑 `npm run check`（会花少量钱）。
- 改了 `web-ui/` 源码必须 `npm run build:web` 并提交 `public/app/` 产物，否则前端契约测试会红。

## 发布

- push 到 `master` 触发 `.github/workflows/release.yml`：先跑 `npm test`（Linux runner 需补装 `zsh`，Node 固定 24），全绿后 release-please 按常规提交（`feat` → 次版本、`fix` → 修订号）开或更新「发布 PR」，合并即打 tag 并创建 GitHub Release。
- 版本基线锚点为 tag `v7.0.0`（commit `86e2276`）；仓库须开启「Allow GitHub Actions to create and approve pull requests」且 workflow 默认权限为 write，否则 release-please 建不了 PR。
- 提交主题的分隔冒号须用半角 `:`——release-please 解析不了全角 `：`，那条提交会不进发布说明。
- `npm run publish`（构建前端 + 打 .app + 重启服务）只能在 Bundle 外的源码目录执行。
- 文档站发布笔记走本地 `npm run docs:notes`（从 git 历史生成，幂等注入标记区）。
