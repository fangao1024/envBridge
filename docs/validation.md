# V1.0 验证记录

日期：2026-09-28。

| 检查 | 结果 |
| --- | --- |
| Manifest、入口文件、图标、JavaScript 语法及 CSP 兼容 HTML | 通过 |
| Node 单元 / 适配器测试 | 12 / 12 通过 |
| Chromium 153.0.8010.12（Chrome for Testing）真实 MV3 测试 | 通过 |
| Microsoft Edge 154.0.4258.37 真实 MV3 测试 | 通过 |
| 独立工作台、预览、结果与弹窗截图视觉检查 | 完成 |

两种浏览器均验证：

- 不同 loopback 主机之间的 3 个 Cookie（含 HttpOnly、非根 Path、会话与持久 Cookie）。
- 3 个 localStorage Key、2 个 sessionStorage Key；Merge 保留目标额外 Key。
- 1,204 条源 IndexedDB 记录，含内联 / 复合 / 二进制主键、唯一 / multiEntry 索引、Date、Blob、File、BigInt、TypedArray、Map、Set、循环与共享引用。
- 超过传输块大小的 Unicode 字符串，确保 emoji 不在分块边界损坏。
- 目标数据库结构合并、逐项选择、Clear & Clone、取消确认、Replace Database 的版本与结构恢复。
- 数据库被占用时显示阻塞，释放后继续；关闭 UI 并重新打开后任务继续。
- 同 Origin 多源标签页的 sessionStorage 精确选择、自动刷新。
- 预览后目标刷新时拒绝向新文档写入，不误报成功。
- 预设保留；扩展持久 / 会话存储不含测试网页数据值；页面无 JavaScript 异常。

自动化测试仅在临时 manifest 中预授予两个 loopback 测试主机权限。交付 manifest 没有永久 `host_permissions`；真实的首次授权、拒绝授权、撤销授权流程，及 HTTPS → HTTP 的浏览器原生行为需按 README 人工验收。Cookie 转换规则已包含对应单元测试。

自动化报告位于 `artifacts/chromium-report.json` 和 `artifacts/msedge-report.json`；截图位于 `artifacts/`。这些开发产物不进入安装包。

## V1.0.1 Cookie 父域权限回归

日期：2026-09-29。

- Node 单元 / 适配器测试：18 / 18 通过，新增 6 项 Cookie 权限及读取测试，覆盖合法父域、公共后缀与私有后缀边界、localhost / IP、存储区定位、权限缺失报错及兄弟子域过滤。
- Chromium 153.0.8010.12 与 Microsoft Edge 154.0.4258.37 的 Cookie 专项回归均通过。使用临时浏览器配置与虚构 Cookie，拦截并本地响应全部页面请求，没有访问真实的 51miz 网站或读取用户 Cookie。
- 浏览器原生 CDP 查询确认 `https://www.51miz.com` 的测试页面可用 2 个 `.51miz.com` 父域 Cookie；旧版仅有 `https://www.51miz.com/*` 授权时，扩展 API 读取结果为 0。新版在该权限状态下明确报告 `COOKIE_PERMISSION_REQUIRED`。
- 增加所选主机及合法父域的 HTTP / HTTPS 权限后，预览与迁移均包含全部 3 个测试 Cookie，涵盖父域、HttpOnly、Secure 和非根 Path；无关兄弟子域以及父域 hostOnly Cookie 被排除。
- 两种浏览器的完整 MV3 回归再次通过，包含 Cookie、两种 Web Storage、1,204 条富类型 IndexedDB 记录及原有迁移与文档变更保护场景。

专项报告：`artifacts/chromium-cookie-regression.json`、`artifacts/msedge-cookie-regression.json`。专项测试中的网站权限同样仅存在于临时 manifest；交付版仍使用按需授权。

## V1.0.2 manifest 权限请求回归

日期：2026-09-29。

1.0.1 的测试 manifest 使用 `*://` 预授权，掩盖了交付 manifest 分别声明 HTTP / HTTPS 时的请求格式问题。本次将所有测试预授权同样拆成 HTTP / HTTPS，交付 manifest 保持原有按需权限声明。

- Node 单元 / 适配器测试：19 / 19 通过。新增检查直接读取交付 manifest，验证每个请求的权限模式均能被单个声明覆盖。
- Chromium 153.0.8010.12 与 Microsoft Edge 154.0.4258.37 均通过真实按钮点击复现 1.0.1 的错误：`Only permissions specified in the manifest may be requested.`；原请求的 `*://www.51miz.com/*`、`*://51miz.com/*` 无法匹配分开的 HTTP / HTTPS 声明。
- 修改为明确的 HTTP / HTTPS 请求后，两种浏览器的权限检查、页面预览、3 个测试 Cookie 的迁移与写入校验均通过，继续覆盖父域、HttpOnly、Secure、非根 Path 及无关子域过滤。
- 两种浏览器的完整存储迁移回归通过，包括两种 Web Storage、1,204 条富类型 IndexedDB 记录、确认流程与文档变更保护。

专项报告中的 `legacyWildcardRequest` 保存原始报错，`explicitSchemeRequest`、`verifiedCloneCount` 记录修复后的结果。测试未访问真实网站或读取用户 Cookie；原生首次授权与拒绝授权弹窗仍需人工验收。

## V1.1.0 Cookie 作用域与会话历史撤销

日期：2026-09-29。

- Node 单元 / 适配器测试：26 / 26 通过，包含父域 / 子域 / host-only 映射、localhost / IPv4 / IPv6、合法公共后缀边界、历史容量与倒序限制、Storage 恢复失败回滚、自增键恢复及同名 Cookie 删除歧义保护。
- Chromium 153.0.8010.12 与 Microsoft Edge 154.0.4258.37 的完整 MV3 迁移及原有 Cookie 权限专项回归通过。
- 两种浏览器的新历史专项回归均通过：`.51miz.com` 迁入 `https://www.dev.com` 时，Domain 为 `.dev.com`；原 host-only Cookie 保持 `www.dev.com` 的 host-only 作用域。
- 四种存储合并迁移后，通过实际历史撤销按钮恢复覆盖前的值、删除新增项、保留无关数据；IndexedDB 恢复原 v3、索引 / 表 / 主键 / 富类型记录及自增键 201，并删除本次新增数据库。
- 关闭扩展 UI、通过 CDP 停止扩展后台，再重新打开后，撤销快照仍在；真实确认按钮后的权限请求与任务启动正常。
- 验证 Clear & Clone 和 Replace Database 的撤销、localhost 的 host-only Cookie 写入及新增 Cookie 删除、唯一索引冲突导致部分失败后的恢复、多次迁移必须倒序撤销。
- 目标 Blob 导致快照超过预算时，整个迁移在第一项 Cookie 写入前终止；模拟浏览器拒绝保存会话快照时，同样没有目标修改，也没有错误的历史条目。
- 持久存储 `storage.local` 与公开历史 / 进度消息不含目标值；仅用于撤销的 `storage.session` 快照包含所需原始目标数据，与新的隐私政策一致。历史页截图完成视觉检查。

历史报告：`artifacts/chromium-history-report.json`、`artifacts/msedge-history-report.json`；截图：`artifacts/chromium-history.png`、`artifacts/msedge-history.png`。测试使用临时配置、虚构数据和本地拦截页面，不访问真实网站或用户 Cookie。交付版没有永久主机授权。

## V1.1.0 UI 布局与 SVG 图标修正

日期：2026-09-29。

- 将独立页面、交换环境、数据类型、方向及结果状态的字符图标替换为本地 SVG 图标，统一尺寸、线宽及颜色；保留现有品牌 Logo。装饰图标不进入无障碍名称。
- 弹窗内容单独滚动，操作栏保留在滚动区域外。几何检查确认两者没有重叠，`workspace` 图标与按钮中心的水平、垂直偏移均为 0px；切换视图后滚动位置归零。
- 完成 460 × 600 弹窗以及 1200px、420px、360px 独立页面的截图检查；360px 页面宽度为 360px，没有横向溢出。检查迁移选择、策略展开、历史、预设、设置和关于页面，并检查完整迁移测试生成的预览与结果截图。
- `npm.cmd run check`、26 / 26 单元与适配器测试及 Chromium 完整 MV3 迁移回归通过，页面没有 JavaScript 异常。

UI 截图与几何检查记录位于 `artifacts/ui-after/`；修改前截图位于 `artifacts/ui-before/`。UI 检查使用隔离浏览器配置及本地演示页面。

## V1.1.1 后台脚本抓取故障处理

日期：2026-09-30。

- 用户 Chrome 报告 `An unknown error occurred when fetching the script.`。Chrome 官方文档用相同报错演示扩展后台模块导入失败；检查本地文件与导入链后，没有发现缺失文件，因此无法把某个具体文件确认为根因。
- 将后台模块在开发时构建为一个自包含脚本，manifest 直接注册 `src/background.bundle.js`。安装包包含生成结果，无需用户安装 npm 依赖；`check` 对照源码验证 bundle 未过期，`package` 自动重新构建。
- Node 单元与适配器 26 / 26 通过；Chromium 153 和 Edge 154 的完整 MV3 迁移回归通过；Chromium Cookie 权限与历史撤销专项回归通过。ZIP 的文件、校验和及源码一致性检查通过。
- 用户当前 Chrome 154 的扩展管理界面未能由自动化安全地访问，因此其配置中重新加载 1.1.1 后是否消除该报错，仍需在该浏览器确认。

## V1.1.1 工具栏弹窗加载修复

日期：2026-10-08。

- 用户 Chrome 确认版本 1.1.1、图标启用、弹窗地址正确且 `INIT` 后台连接成功；关闭全部开发者工具后点击图标仍无响应。
- 在隔离 Chromium 中通过 `chrome.action.openPopup()` 复现：实际 `POPUP` 上下文已经创建，页面脚本初始化成功，但文档停在 `interactive` / `hidden`。移除外部 SVG `<use>` 后，立即转为 `complete` / `visible`，打开弹窗的 Promise 成功完成。
- 将图标符号内联到 `popup.html`，静态和动态图标统一使用同文档的 `#icon-…` 引用。符号 ID 使用独立前缀，避免覆盖交换环境等按钮的 ID；图标形状和样式保持原样。
- 新增 `tests/popup-browser.mjs` / `npm.cmd run test:popup`。测试在打开任何扩展标签页之前启动真实 action popup，检查 5 秒内成功显示、页面加载完成、后台初始化成功、图标实际几何非空以及没有重复 DOM ID。
- Chromium 153 的真实弹窗启动测试通过（443 ms）；Edge 154 同项测试通过（1,190 ms）。静态检查和全部 26 项单元 / 适配器测试通过。
- 测试使用隔离临时配置和原始按需权限 manifest，不访问用户网站或读取实际 Cookie。用户当前 Chrome 的工具栏点击效果需重新加载已修复文件后确认。

弹窗报告：`artifacts/chromium-popup-report.json`、`artifacts/msedge-popup-report.json`；真实弹窗截图：`artifacts/chromium-toolbar-popup.png`、`artifacts/msedge-toolbar-popup.png`。

## 中英文界面与设置切换

日期：2026-10-08。

- 设置新增「界面语言」，支持简体中文 / English，默认简体中文；切换立即生效，并以独立的 `uiLanguage` 偏好保存在扩展本地存储中。语言不写入迁移预设，也不会修改默认迁移策略。
- 翻译覆盖导航、设置、预览、属性详情、警告、确认对话框、结果、日志、历史、预设、关于及隐私政策。错误码、预设名、网页标题、Storage Key、数据库 / 索引名及网站数据保持原值。
- Chromium 153 与 Edge 154 的中英文专项回归均通过：切换和重新打开后语言保持；其他已打开的弹窗、工作台与隐私政策同步更新；预览勾选（包括暂时禁用的数据类别）、详情展开和未保存设置保留；英文下实际迁移与历史撤销成功；中文 Key 和数据值保持原样。
- 完成英文设置、460 × 600 弹窗及迁移结果截图检查。弹窗没有横向溢出，主要操作在视口内。
- 静态检查及 28 / 28 单元 / 适配器测试通过；两种浏览器的完整 MV3 迁移回归与真实工具栏弹窗启动测试通过。所有浏览器检查使用隔离临时配置和虚构数据。

专项测试：`npm.cmd run test:i18n`、`npm.cmd run test:i18n -- --edge`。报告：`artifacts/chromium-i18n-report.json`、`artifacts/msedge-i18n-report.json`；截图：`artifacts/*-settings-en.png`、`artifacts/*-popup-en.png`、`artifacts/*-result-en.png`。
