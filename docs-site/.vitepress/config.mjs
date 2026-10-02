/** VitePress 配置：中文为主（默认语言），英文为镜像。
 *  导航结构：guides（怎么用）/ reference（速查）/ release-notes（变更）。
 *  本文件只做站点结构，不引插件（保持文档栈最小）。 */
import { defineConfig } from 'vitepress';

const zhNav = [
  { text: '指南', link: '/zh/guide/quick-start' },
  { text: '速查', link: '/zh/reference/commands' },
  { text: '发布笔记', link: '/zh/release-notes/' },
];
const enNav = [
  { text: 'Guides', link: '/en/guide/quick-start' },
  { text: 'Reference', link: '/en/reference/commands' },
  { text: 'Release Notes', link: '/en/release-notes/' },
];

export default defineConfig({
  title: 'AuroraAgent',
  description: '本地 Agent 运行时：终端 + 网页双客户端，极简依赖，macOS 常驻',
  lang: 'zh-CN',
  cleanUrls: true,
  srcDir: '.',
  themeConfig: {
    logo: '/icon.svg',
    socialLinks: [{ icon: 'github', link: 'https://github.com/AuroraAeon/AuroraAgent' }],
    search: { provider: 'local' },
    footer: { message: '极简依赖 · macOS 本地运行时' },
  },
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: 'AuroraAgent',
      description: '本地 Agent 运行时：终端 + 网页双客户端，极简依赖，macOS 常驻',
      themeConfig: {
        nav: zhNav,
        sidebar: {
          '/zh/': [
            {
              text: '指南',
              items: [
                { text: '快速开始', link: '/zh/guide/quick-start' },
                { text: 'Agent Loop 架构', link: '/zh/guide/agent-loop' },
                { text: 'Goal 目标模式', link: '/zh/guide/goal-mode' },
                { text: '消息队列', link: '/zh/guide/message-queue' },
                { text: '定时任务', link: '/zh/guide/scheduled-tasks' },
                { text: '屏幕操作', link: '/zh/guide/screen-control' },
                { text: '网页工作台', link: '/zh/guide/web-ui' },
                { text: '终端 TUI', link: '/zh/guide/terminal' },
                { text: '技能系统', link: '/zh/guide/skills' },
                { text: 'MCP 服务器（实验）', link: '/zh/guide/mcp' },
                { text: '自定义提供方', link: '/zh/guide/providers' },
              ],
            },
            {
              text: '速查',
              items: [
                { text: '命令与斜杠命令', link: '/zh/reference/commands' },
                { text: 'HTTP API', link: '/zh/reference/http-api' },
                { text: '配置与环境变量', link: '/zh/reference/config' },
                { text: '检查点与回滚', link: '/zh/reference/checkpoints' },
                { text: '事件钩子', link: '/zh/reference/hooks' },
                { text: '规则', link: '/zh/reference/rules' },
                { text: '检索加速（ripgrep）', link: '/zh/reference/ripgrep' },
                { text: '提示缓存', link: '/zh/reference/prompt-cache' },
                { text: '会话全文检索', link: '/zh/reference/search' },
                { text: '文件新鲜度与原子落盘', link: '/zh/reference/file-tracker' },
                { text: '终端设计规范', link: '/zh/reference/tui-design' },
                { text: '网页设计规范', link: '/zh/reference/web-design' },
                { text: '术语与文案规约', link: '/zh/reference/terminology' },
              ],
            },
            { text: '发布笔记', link: '/zh/release-notes/' },
          ],
        },
        outline: { label: '本页目录', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      title: 'AuroraAgent',
      description: 'Local agent runtime: terminal + web clients, zero-dependency backend, macOS resident',
      link: '/en/',
      themeConfig: {
        nav: enNav,
        sidebar: {
          '/en/': [
            {
              text: 'Guides',
              items: [
                { text: 'Quick Start', link: '/en/guide/quick-start' },
                { text: 'Agent Loop Architecture', link: '/en/guide/agent-loop' },
                { text: 'Goal Mode', link: '/en/guide/goal-mode' },
                { text: 'Message Queue', link: '/en/guide/message-queue' },
                { text: 'Scheduled Tasks', link: '/en/guide/scheduled-tasks' },
                { text: 'Screen Control', link: '/en/guide/screen-control' },
                { text: 'Web Workbench', link: '/en/guide/web-ui' },
                { text: 'Terminal TUI', link: '/en/guide/terminal' },
                { text: 'Skills', link: '/en/guide/skills' },
                { text: 'MCP Servers (Experimental)', link: '/en/guide/mcp' },
                { text: 'Custom Providers', link: '/en/guide/providers' },
              ],
            },
            {
              text: 'Reference',
              items: [
                { text: 'Commands & Slash Commands', link: '/en/reference/commands' },
                { text: 'HTTP API', link: '/en/reference/http-api' },
                { text: 'Config & Environment', link: '/en/reference/config' },
                { text: 'Checkpoints & Rollback', link: '/en/reference/checkpoints' },
                { text: 'Event Hooks', link: '/en/reference/hooks' },
                { text: 'Rules', link: '/en/reference/rules' },
                { text: 'Search Acceleration (ripgrep)', link: '/en/reference/ripgrep' },
                { text: 'Prompt Cache', link: '/en/reference/prompt-cache' },
                { text: 'Full-Text Session Search', link: '/en/reference/search' },
                { text: 'File Freshness & Atomic Writes', link: '/en/reference/file-tracker' },
                { text: 'Terminal Design Spec', link: '/en/reference/tui-design' },
                { text: 'Web Design Spec', link: '/en/reference/web-design' },
                { text: 'Terminology & Copy', link: '/en/reference/terminology' },
              ],
            },
            { text: 'Release Notes', link: '/en/release-notes/' },
          ],
        },
        outline: { label: 'On this page', level: [2, 3] },
        docFooter: { prev: 'Previous', next: 'Next' },
      },
    },
  },
});
